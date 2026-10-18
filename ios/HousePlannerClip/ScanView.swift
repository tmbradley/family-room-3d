import SwiftUI
import RoomPlan

struct ScanView: View {
    @EnvironmentObject var uploads: UploadManager
    @StateObject private var scanner = RoomScanController()
    @State private var manualCode = ""
    @State private var photos: [UIImage] = []
    @State private var showingCamera = false
    @State private var isUploading = false
    @State private var progress = 0.0
    @State private var finished = false
    @State private var errorMessage: String?

    var body: some View {
        ZStack {
            switch scanner.phase {
            case .scanning, .processing:
                captureScreen
            case .done:
                if finished { finishedView } else if let room = scanner.capturedRoom { reviewView(room) }
            case .idle, .failed:
                startView
            }
            if isUploading { uploadingOverlay }
        }
        .alert("Something went wrong", isPresented: Binding(get: { errorMessage != nil }, set: { if !$0 { errorMessage = nil } })) {
            Button("OK") { errorMessage = nil }
        } message: { Text(errorMessage ?? "") }
        .onChange(of: scanner.phase) { _, phase in
            if case .failed(let message) = phase { errorMessage = message }
        }
    }

    // MARK: Screens

    private var captureScreen: some View {
        ZStack(alignment: .bottom) {
            RoomCaptureContainer(controller: scanner).ignoresSafeArea()
            HStack(spacing: 20) {
                Button("Cancel", role: .cancel) { scanner.cancel() }
                    .buttonStyle(.bordered).tint(.red)
                if scanner.phase == .scanning {
                    Button("Done") { scanner.finish() }.buttonStyle(.borderedProminent).tint(.green)
                } else {
                    ProgressView("Processing…").padding(.horizontal)
                }
            }
            .controlSize(.large)
            .padding(.bottom, 30)
        }
    }

    private var startView: some View {
        VStack(spacing: 20) {
            Image(systemName: "camera.metering.center.weighted").font(.system(size: 64)).foregroundStyle(.blue)
            Text("Scan a room").font(.largeTitle.bold())
            if !RoomScanController.isSupported {
                notice("This iPhone has no LiDAR scanner. Room scanning needs an iPhone 12 Pro or newer Pro model.", color: .red)
            }
            switch uploads.codeState {
            case .valid(let label):
                notice("Paired. Scanning: \(label)", color: .green)
            case .checking:
                ProgressView("Checking pairing code…")
            case .invalid(let message):
                notice(message, color: .orange)
                codeEntry
            case .none:
                Text("In the House Planner editor, click Pair phone and scan the QR code, or type the code here.")
                    .font(.callout).foregroundStyle(.secondary).multilineTextAlignment(.center)
                codeEntry
            }
            Spacer().frame(height: 20)
            Button {
                scanner.start()
            } label: {
                Text("Start scanning").font(.headline).frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent).controlSize(.large)
            .disabled(!uploads.isTokenValid || !RoomScanController.isSupported)
        }
        .padding()
    }

    private var codeEntry: some View {
        HStack {
            TextField("XXXX-XXXX-XXXX", text: $manualCode)
                .textInputAutocapitalization(.characters).autocorrectionDisabled()
                .font(.title3.monospaced()).textFieldStyle(.roundedBorder)
            Button("Use code") { uploads.setToken(manualCode) }
                .disabled(manualCode.trimmingCharacters(in: .whitespaces).count < 12)
        }
    }

    private func reviewView(_ room: CapturedRoom) -> some View {
        VStack(spacing: 18) {
            Image(systemName: "checkmark.circle.fill").font(.system(size: 64)).foregroundStyle(.green)
            Text("Scan complete").font(.largeTitle.bold())
            Text("\(room.walls.count) walls · \(room.doors.count) doors · \(room.windows.count) windows · \(room.openings.count) openings")
                .foregroundStyle(.secondary)
            Text(photos.isEmpty ? "Optionally add a few photos of the room." : "\(photos.count) photo(s) added")
                .font(.callout)
            Spacer()
            Button {
                showingCamera = true
            } label: {
                Label(photos.isEmpty ? "Add photos" : "Add another photo", systemImage: "camera").frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered).controlSize(.large)
            .disabled(photos.count >= UploadManager.maxPhotos || !UIImagePickerController.isSourceTypeAvailable(.camera))
            Button {
                upload(room)
            } label: {
                Text("Upload scan").font(.headline).frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent).controlSize(.large)
            Button("Scan again", role: .destructive) { photos = []; scanner.reset() }
        }
        .padding()
        .sheet(isPresented: $showingCamera) { CameraPicker(images: $photos, isPresented: $showingCamera) }
    }

    private var finishedView: some View {
        VStack(spacing: 18) {
            Image(systemName: "icloud.and.arrow.up.fill").font(.system(size: 64)).foregroundStyle(.blue)
            Text("Uploaded").font(.largeTitle.bold())
            Text("Open the editor on your computer: the scan is waiting under Scanning for you to review and promote to Current.")
                .multilineTextAlignment(.center).foregroundStyle(.secondary)
        }
        .padding()
    }

    private var uploadingOverlay: some View {
        ZStack {
            Color.black.opacity(0.6).ignoresSafeArea()
            VStack(spacing: 16) {
                ProgressView(value: progress).frame(width: 220)
                Text("Uploading… \(Int(progress * 100))%").font(.headline).foregroundStyle(.white)
            }
            .padding(32)
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 16))
        }
    }

    private func notice(_ text: String, color: Color) -> some View {
        Text(text).font(.callout).padding().frame(maxWidth: .infinity)
            .background(color.opacity(0.12), in: RoundedRectangle(cornerRadius: 12))
    }

    // MARK: Actions

    private func upload(_ room: CapturedRoom) {
        isUploading = true
        progress = 0
        Task {
            do {
                try await uploads.uploadScan(room: room, photos: photos) { value in progress = value }
                finished = true
            } catch {
                errorMessage = error.localizedDescription
            }
            isUploading = false
        }
    }
}

/// Camera for optional room photos.
struct CameraPicker: UIViewControllerRepresentable {
    @Binding var images: [UIImage]
    @Binding var isPresented: Bool

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ uiViewController: UIImagePickerController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let parent: CameraPicker
        init(_ parent: CameraPicker) { self.parent = parent }

        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            if let image = info[.originalImage] as? UIImage { parent.images.append(image) }
            parent.isPresented = false
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) { parent.isPresented = false }
    }
}
