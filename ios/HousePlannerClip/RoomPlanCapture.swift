import SwiftUI
import RoomPlan

class RoomPlanCapture: ObservableObject {
    @Published var isScanning = false
    @Published var capturedRoom: CapturedRoom?
    
    private var roomCaptureSession: RoomCaptureSession?
    
    func startScanning() {
        isScanning = true
        capturedRoom = nil
        roomCaptureSession = RoomCaptureSession()
        
        let config = RoomCaptureSession.Configuration()
        roomCaptureSession?.run(configuration: config)
    }
    
    func finishScanning() {
        isScanning = false
        roomCaptureSession?.stop { capturedData in
            DispatchQueue.main.async {
                self.capturedRoom = capturedData
            }
        }
    }
    
    func cancelScanning() {
        isScanning = false
        roomCaptureSession?.stop()
        roomCaptureSession = nil
    }
    
    func reset() {
        isScanning = false
        capturedRoom = nil
        roomCaptureSession = nil
    }
}

struct RoomCaptureViewRepresentable: UIViewRepresentable {
    let roomCapture: RoomPlanCapture
    
    func makeUIView(context: Context) -> RoomCaptureView {
        let captureView = RoomCaptureView(frame: .zero)
        
        if let session = roomCapture.roomCaptureSession {
            captureView.captureSession = session
        }
        
        return captureView
    }
    
    func updateUIView(_ uiView: RoomCaptureView, context: Context) {}
}

// Extension to make RoomCaptureSession accessible
extension RoomPlanCapture {
    var roomCaptureSession: RoomCaptureSession? {
        get { roomCaptureSession }
        set { roomCaptureSession = newValue }
    }
}
