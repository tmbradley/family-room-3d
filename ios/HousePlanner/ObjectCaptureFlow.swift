import SwiftUI
import RealityKit

/// "Capture this piece": Object Capture on the phone (LiDAR iPhone, iOS 17+), then on-device
/// photogrammetry to a USDZ, uploaded and attached to the furniture placement the code was made for.
///
/// Flow: ObjectCaptureSession (ready -> detecting -> capturing, up to three passes) writes images to a
/// folder; PhotogrammetrySession turns that folder into model.usdz; PlannerClient uploads it.
@MainActor
final class ObjectCaptureController: ObservableObject {
    enum Step: Equatable { case idle, capturing, reconstructing(Double), readyToUpload, uploading(Double), done, failed(String) }

    @Published private(set) var step: Step = .idle
    @Published private(set) var captureState = "Starting…"
    @Published private(set) var passCompleted = false
    @Published private(set) var passes = 0
    private(set) var session: ObjectCaptureSession?
    private var stateTask: Task<Void, Never>?
    private var passTask: Task<Void, Never>?
    private var workDir: URL?

    /// Object Capture needs a LiDAR iPhone; photogrammetry runs on the same devices.
    static var isSupported: Bool { ObjectCaptureSession.isSupported && PhotogrammetrySession.isSupported }

    var imagesDir: URL? { workDir?.appendingPathComponent("Images", isDirectory: true) }

    func start() {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("capture-\(UUID().uuidString)", isDirectory: true)
        let images = dir.appendingPathComponent("Images", isDirectory: true)
        let checkpoints = dir.appendingPathComponent("Checkpoints", isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: images, withIntermediateDirectories: true)
            try FileManager.default.createDirectory(at: checkpoints, withIntermediateDirectories: true)
        } catch { step = .failed(error.localizedDescription); return }
        workDir = dir
        var configuration = ObjectCaptureSession.Configuration()
        configuration.checkpointDirectory = checkpoints
        let session = ObjectCaptureSession()
        self.session = session
        passes = 0
        session.start(imagesDirectory: images, configuration: configuration)
        step = .capturing
        stateTask = Task { [weak self] in
            for await state in session.stateUpdates {
                guard let self else { return }
                self.apply(state)
            }
        }
        passTask = Task { [weak self] in
            for await done in session.userCompletedScanPassUpdates {
                guard let self else { return }
                self.passCompleted = done
                if done { self.passes += 1 }
            }
        }
    }

    private func apply(_ state: ObjectCaptureSession.CaptureState) {
        switch state {
        case .initializing: captureState = "Starting…"
        case .ready: captureState = "Point at the piece, then tap Detect"
        case .detecting: captureState = "Adjust the box around the piece, then tap Start capture"
        case .capturing: captureState = "Walk slowly around the piece"
        case .finishing: captureState = "Saving images…"
        case .completed:
            captureState = "Captured"
            Task { await reconstruct() }
        case .failed(let error):
            step = .failed(error.localizedDescription)
        @unknown default: break
        }
    }

    func detect() { _ = session?.startDetecting() }
    func startCapturing() { session?.startCapturing() }
    func nextPass() { session?.beginNewScanPass(); passCompleted = false }
    func finishCapture() { session?.finish() }

    func cancel() {
        session?.cancel()
        cleanup()
        step = .idle
    }

    /// On-device photogrammetry: Images/ -> model.usdz.
    private func reconstruct() async {
        guard let dir = workDir, let images = imagesDir else { return }
        stateTask?.cancel(); passTask?.cancel()
        session = nil // release the camera before reconstruction
        step = .reconstructing(0)
        let output = dir.appendingPathComponent("model.usdz")
        do {
            var configuration = PhotogrammetrySession.Configuration()
            configuration.checkpointDirectory = dir.appendingPathComponent("Checkpoints", isDirectory: true)
            let photogrammetry = try PhotogrammetrySession(input: images, configuration: configuration)
            try photogrammetry.process(requests: [.modelFile(url: output)])
            for try await event in photogrammetry.outputs {
                switch event {
                case .requestProgress(_, let fraction): step = .reconstructing(fraction)
                case .requestError(_, let error): throw error
                case .requestComplete: break
                case .processingCancelled: step = .idle; return
                case .processingComplete:
                    if FileManager.default.fileExists(atPath: output.path) { modelURL = output; step = .readyToUpload } else { step = .failed("Reconstruction produced no model") }
                    return
                default: break
                }
            }
        } catch {
            step = .failed(error.localizedDescription)
        }
    }

    @Published private(set) var modelURL: URL?

    func upload(with client: PlannerClient, label: String) async {
        guard let url = modelURL else { return }
        step = .uploading(0)
        do {
            try await client.uploadModel(fileURL: url, label: label) { [weak self] p in self?.step = .uploading(p) }
            step = .done
            cleanup()
        } catch {
            step = .failed(error.localizedDescription)
        }
    }

    private func cleanup() {
        stateTask?.cancel(); passTask?.cancel()
        if let dir = workDir { try? FileManager.default.removeItem(at: dir) }
        workDir = nil; session = nil; modelURL = nil
    }
}

struct ObjectCaptureFlowView: View {
    @EnvironmentObject var client: PlannerClient
    @StateObject private var capture = ObjectCaptureController()
    @State private var label = ""

    var body: some View {
        VStack(spacing: 16) {
            switch capture.step {
            case .idle:
                intro
            case .capturing:
                capturingView
            case .reconstructing(let f):
                progressView("Building the 3D model on your iPhone…", f)
            case .readyToUpload:
                Label("Model built", systemImage: "cube.fill").font(.title3.bold())
                uploadForm
            case .uploading(let f):
                progressView("Uploading…", f)
            case .done:
                Label("Model attached", systemImage: "checkmark.circle.fill").font(.title2.bold()).foregroundStyle(.green)
                Text("Open the editor: the piece now shows your 3D model. You can roll it back from History.").multilineTextAlignment(.center).foregroundStyle(.secondary)
            case .failed(let message):
                Label(message, systemImage: "exclamationmark.triangle").foregroundStyle(.orange)
                Button("Try again") { capture.cancel() }.buttonStyle(.bordered)
            }
        }
        .padding()
        .onAppear { if label.isEmpty { label = client.info?.roomLabel ?? "Captured piece" } }
    }

    private var intro: some View {
        VStack(spacing: 14) {
            Image(systemName: "cube.transparent").font(.system(size: 56)).foregroundStyle(.purple)
            Text("Capture “\(client.info?.roomLabel ?? "this piece")”").font(.title2.bold()).multilineTextAlignment(.center)
            Text("Put the piece where you can walk all the way around it, in even light. The capture takes a few minutes, and the model is built on this iPhone.")
                .font(.callout).foregroundStyle(.secondary).multilineTextAlignment(.center)
            if !ObjectCaptureController.isSupported {
                Text("Object Capture needs an iPhone with LiDAR (12 Pro or a newer Pro model) on iOS 17 or later.").font(.callout).foregroundStyle(.red)
            }
            Button { capture.start() } label: { Text("Start capture").font(.headline).frame(maxWidth: .infinity) }
                .buttonStyle(.borderedProminent).controlSize(.large)
                .disabled(!ObjectCaptureController.isSupported || !client.canUpload)
        }
    }

    @ViewBuilder private var capturingView: some View {
        if let session = capture.session {
            ZStack(alignment: .bottom) {
                ObjectCaptureView(session: session).ignoresSafeArea()
                VStack(spacing: 10) {
                    Text(capture.captureState).font(.callout.bold()).padding(8).background(.ultraThinMaterial, in: Capsule())
                    HStack {
                        Button("Cancel", role: .cancel) { capture.cancel() }.buttonStyle(.bordered).tint(.red)
                        Button("Detect") { capture.detect() }.buttonStyle(.bordered)
                        Button("Start capture") { capture.startCapturing() }.buttonStyle(.borderedProminent)
                        if capture.passCompleted {
                            if capture.passes < 3 { Button("Another pass") { capture.nextPass() }.buttonStyle(.bordered) }
                            Button("Finish") { capture.finishCapture() }.buttonStyle(.borderedProminent).tint(.green)
                        }
                    }
                    .controlSize(.regular)
                }
                .padding(.bottom, 24)
            }
        } else {
            ProgressView()
        }
    }

    private var uploadForm: some View {
        VStack(spacing: 10) {
            TextField("Name", text: $label).textFieldStyle(.roundedBorder)
            Button { Task { await capture.upload(with: client, label: label) } } label: { Text("Upload and attach").font(.headline).frame(maxWidth: .infinity) }
                .buttonStyle(.borderedProminent).controlSize(.large)
        }
    }

    private func progressView(_ title: String, _ f: Double) -> some View {
        VStack(spacing: 10) {
            ProgressView(value: f).frame(width: 240)
            Text("\(title) \(Int(f * 100))%").font(.headline)
        }
    }
}
