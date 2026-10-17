import SwiftUI
import RoomPlan

struct ScanView: View {
    @EnvironmentObject var uploadManager: UploadManager
    @StateObject private var roomCapture = RoomPlanCapture()
    @State private var showingPhotoPicker = false
    @State private var capturedPhotos: [UIImage] = []
    @State private var isUploading = false
    @State private var uploadProgress: Double = 0
    @State private var errorMessage: String?
    
    var body: some View {
        ZStack {
            if roomCapture.isScanning {
                RoomCaptureViewRepresentable(roomCapture: roomCapture)
                    .edgesIgnoringSafeArea(.all)
                
                VStack {
                    Spacer()
                    
                    HStack(spacing: 20) {
                        Button(action: { roomCapture.cancelScanning() }) {
                            Text("Cancel")
                                .font(.headline)
                                .padding()
                                .frame(minWidth: 120)
                                .background(Color.red)
                                .foregroundColor(.white)
                                .cornerRadius(12)
                        }
                        
                        Button(action: { roomCapture.finishScanning() }) {
                            Text("Done")
                                .font(.headline)
                                .padding()
                                .frame(minWidth: 120)
                                .background(Color.green)
                                .foregroundColor(.white)
                                .cornerRadius(12)
                        }
                    }
                    .padding()
                }
            } else if let room = roomCapture.capturedRoom {
                completionView(room: room)
            } else {
                startView
            }
            
            if isUploading {
                uploadingOverlay
            }
        }
        .alert("Error", isPresented: .constant(errorMessage != nil)) {
            Button("OK") { errorMessage = nil }
        } message: {
            if let error = errorMessage {
                Text(error)
            }
        }
    }
    
    private var startView: some View {
        VStack(spacing: 24) {
            Image(systemName: "camera.metering.center.weighted")
                .font(.system(size: 80))
                .foregroundColor(.blue)
            
            Text("Scan Room")
                .font(.largeTitle)
                .fontWeight(.bold)
            
            Text("Use your iPhone's LiDAR to capture room dimensions")
                .font(.body)
                .foregroundColor(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal)
            
            if !uploadManager.isTokenValid {
                VStack(spacing: 12) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .font(.title)
                        .foregroundColor(.orange)
                    Text("No valid pairing code")
                        .font(.headline)
                    Text("Please generate a pairing code in the web app first")
                        .font(.caption)
                        .foregroundColor(.secondary)
                        .multilineTextAlignment(.center)
                }
                .padding()
                .background(Color.orange.opacity(0.1))
                .cornerRadius(12)
            }
            
            Spacer()
                .frame(height: 40)
            
            Button(action: startScanning) {
                Text("Start Scanning")
                    .font(.headline)
                    .padding()
                    .frame(maxWidth: .infinity)
                    .background(uploadManager.isTokenValid ? Color.blue : Color.gray)
                    .foregroundColor(.white)
                    .cornerRadius(12)
            }
            .disabled(!uploadManager.isTokenValid)
            .padding(.horizontal)
        }
        .padding()
    }
    
    private func completionView(room: CapturedRoom) -> some View {
        VStack(spacing: 24) {
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 80))
                .foregroundColor(.green)
            
            Text("Scan Complete!")
                .font(.largeTitle)
                .fontWeight(.bold)
            
            Text("Now let's capture some photos of the room")
                .font(.body)
                .foregroundColor(.secondary)
                .multilineTextAlignment(.center)
            
            if !capturedPhotos.isEmpty {
                Text("\(capturedPhotos.count) photos captured")
                    .font(.headline)
                    .foregroundColor(.blue)
            }
            
            Spacer()
            
            VStack(spacing: 16) {
                Button(action: { showingPhotoPicker = true }) {
                    Label(capturedPhotos.isEmpty ? "Add Photos" : "Add More Photos", systemImage: "photo.on.rectangle.angled")
                        .font(.headline)
                        .padding()
                        .frame(maxWidth: .infinity)
                        .background(Color.blue)
                        .foregroundColor(.white)
                        .cornerRadius(12)
                }
                
                if !capturedPhotos.isEmpty {
                    Button(action: uploadScan) {
                        Text("Upload Scan")
                            .font(.headline)
                            .padding()
                            .frame(maxWidth: .infinity)
                            .background(Color.green)
                            .foregroundColor(.white)
                            .cornerRadius(12)
                    }
                }
                
                Button(action: reset) {
                    Text("Start Over")
                        .font(.subheadline)
                        .foregroundColor(.red)
                }
            }
            .padding(.horizontal)
        }
        .padding()
        .sheet(isPresented: $showingPhotoPicker) {
            ImagePicker(images: $capturedPhotos, isPresented: $showingPhotoPicker)
        }
    }
    
    private var uploadingOverlay: some View {
        ZStack {
            Color.black.opacity(0.7)
                .edgesIgnoringSafeArea(.all)
            
            VStack(spacing: 20) {
                ProgressView(value: uploadProgress)
                    .progressViewStyle(LinearProgressViewStyle())
                    .frame(width: 200)
                
                Text("Uploading...")
                    .font(.headline)
                    .foregroundColor(.white)
                
                Text("\(Int(uploadProgress * 100))%")
                    .font(.title2)
                    .fontWeight(.bold)
                    .foregroundColor(.white)
            }
            .padding(40)
            .background(Color.white.opacity(0.1))
            .cornerRadius(20)
        }
    }
    
    private func startScanning() {
        guard uploadManager.isTokenValid else {
            errorMessage = "Please enter a valid pairing code first"
            return
        }
        roomCapture.startScanning()
    }
    
    private func reset() {
        roomCapture.reset()
        capturedPhotos = []
        uploadProgress = 0
    }
    
    private func uploadScan() {
        guard let room = roomCapture.capturedRoom else { return }
        
        isUploading = true
        uploadProgress = 0
        
        Task {
            do {
                try await uploadManager.uploadScan(room: room, photos: capturedPhotos) { progress in
                    DispatchQueue.main.async {
                        uploadProgress = progress
                    }
                }
                
                DispatchQueue.main.async {
                    isUploading = false
                    // Success! Show completion
                    errorMessage = nil
                }
            } catch {
                DispatchQueue.main.async {
                    isUploading = false
                    errorMessage = error.localizedDescription
                }
            }
        }
    }
}

// Image picker for capturing photos
struct ImagePicker: UIViewControllerRepresentable {
    @Binding var images: [UIImage]
    @Binding var isPresented: Bool
    
    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.delegate = context.coordinator
        picker.sourceType = .camera
        return picker
    }
    
    func updateUIViewController(_ uiViewController: UIImagePickerController, context: Context) {}
    
    func makeCoordinator() -> Coordinator {
        Coordinator(self)
    }
    
    class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let parent: ImagePicker
        
        init(_ parent: ImagePicker) {
            self.parent = parent
        }
        
        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            if let image = info[.originalImage] as? UIImage {
                parent.images.append(image)
            }
            parent.isPresented = false
        }
        
        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            parent.isPresented = false
        }
    }
}
