import SwiftUI
import RoomPlan

/// Runs a RoomPlan capture. RoomCaptureView owns its RoomCaptureSession: we start and stop it through
/// `captureView.captureSession`, and get the finished room through RoomCaptureViewDelegate
/// (RoomCaptureView processes the raw CapturedRoomData into a CapturedRoom itself after `stop()`).
final class RoomScanController: NSObject, ObservableObject, RoomCaptureViewDelegate {
    enum Phase: Equatable {
        case idle, scanning, processing, done
        case failed(String)
    }

    @Published private(set) var phase: Phase = .idle
    @Published private(set) var capturedRoom: CapturedRoom?

    /// LiDAR devices only (iPhone 12 Pro and later Pro models, recent iPad Pros).
    static var isSupported: Bool { RoomCaptureSession.isSupported }

    /// Created on first use, on the main thread (it's only touched from SwiftUI).
    private(set) lazy var captureView: RoomCaptureView = {
        let view = RoomCaptureView(frame: .zero)
        view.delegate = self
        return view
    }()

    override init() { super.init() }

    // RoomCaptureViewDelegate inherits NSCoding; nothing to persist.
    required init?(coder: NSCoder) { super.init() }
    func encode(with coder: NSCoder) {}

    func start() {
        capturedRoom = nil
        phase = .scanning
        captureView.captureSession.run(configuration: RoomCaptureSession.Configuration())
    }

    /// "Done": stop capturing. RoomCaptureView then processes the scan and calls didPresent.
    func finish() {
        guard phase == .scanning else { return }
        phase = .processing
        captureView.captureSession.stop()
    }

    func cancel() {
        if phase == .scanning || phase == .processing { captureView.captureSession.stop() }
        capturedRoom = nil
        phase = .idle
    }

    func reset() {
        capturedRoom = nil
        phase = .idle
    }

    // MARK: RoomCaptureViewDelegate

    func captureView(shouldPresent roomDataForProcessing: CapturedRoomData, error: Error?) -> Bool {
        if let error {
            let message = error.localizedDescription
            DispatchQueue.main.async { self.phase = .failed(message) }
            return false
        }
        return true // let RoomCaptureView build and show the final room
    }

    func captureView(didPresent processedResult: CapturedRoom, error: Error?) {
        let message = error?.localizedDescription
        DispatchQueue.main.async {
            if let message {
                self.phase = .failed(message)
            } else {
                self.capturedRoom = processedResult
                self.phase = .done
            }
        }
    }
}

/// Hosts the controller's RoomCaptureView in SwiftUI.
struct RoomCaptureContainer: UIViewRepresentable {
    let controller: RoomScanController

    func makeUIView(context: Context) -> RoomCaptureView { controller.captureView }
    func updateUIView(_ uiView: RoomCaptureView, context: Context) {}
}
