import SwiftUI
import RoomPlan
import simd

/// Room scan: RoomPlan capture -> guided photos (each with an optional note) -> review -> upload.
/// Photos are sent with the same pairing code before the import, so the server links every photo to
/// this scan and its room.
struct ScanFlowView: View {
    @EnvironmentObject var client: PlannerClient
    @StateObject private var scanner = RoomScanController()
    @State private var photos: [PlannerClient.Photo] = []
    @State private var labels: [String: String] = [:]
    @State private var labelling = false
    @State private var cameraPrompt: GuidedPrompt?
    @State private var isUploading = false
    @State private var progress = 0.0
    @State private var finishedScanId: Int?
    @State private var errorMessage: String?

    var body: some View {
        ZStack {
            switch scanner.phase {
            case .scanning, .processing:
                captureScreen
            case .done:
                if let id = finishedScanId { finishedView(id) } else if let room = scanner.capturedRoom { reviewView(room) }
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
            if phase == .done, let room = scanner.capturedRoom { Task { await makeLabels(room) } }
        }
        .sheet(item: $cameraPrompt) { prompt in
            CameraPicker(onImage: { image in
                photos.append(PlannerClient.Photo(image: image, prompt: prompt.title, note: "", roomTag: client.info?.roomLabel, tags: prompt.tags))
            }, onDone: { cameraPrompt = nil })
            .ignoresSafeArea()
        }
    }

    // MARK: Screens

    private var startView: some View {
        VStack(spacing: 18) {
            Image(systemName: "camera.metering.center.weighted").font(.system(size: 56)).foregroundStyle(.blue)
            Text("Scan “\(client.info?.roomLabel ?? "room")”").font(.title.bold()).multilineTextAlignment(.center)
            if !RoomScanController.isSupported {
                notice("This iPhone has no LiDAR scanner. Room scanning needs an iPhone 12 Pro or newer Pro model.", color: .red)
            }
            Text("Walk slowly around the room, pointing at every wall. Afterwards the app asks for a few photos.")
                .font(.callout).foregroundStyle(.secondary).multilineTextAlignment(.center)
            Button { scanner.start() } label: { Text("Start scanning").font(.headline).frame(maxWidth: .infinity) }
                .buttonStyle(.borderedProminent).controlSize(.large)
                .disabled(!client.canUpload || !RoomScanController.isSupported)
        }
        .padding()
    }

    private var captureScreen: some View {
        ZStack(alignment: .bottom) {
            RoomCaptureContainer(controller: scanner).ignoresSafeArea()
            HStack(spacing: 20) {
                Button("Cancel", role: .cancel) { scanner.cancel() }.buttonStyle(.bordered).tint(.red)
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

    private func reviewView(_ room: CapturedRoom) -> some View {
        List {
            Section {
                Label("\(room.walls.count) walls · \(room.doors.count) doors · \(room.windows.count) windows · \(room.openings.count) openings · \(room.objects.count) objects", systemImage: "checkmark.circle.fill")
                    .foregroundStyle(.green)
            }
            Section {
                ForEach(GuidedPrompt.all) { prompt in
                    let taken = photos.filter { $0.prompt == prompt.title }.count
                    Button { cameraPrompt = prompt } label: {
                        HStack {
                            Image(systemName: prompt.symbol).frame(width: 26)
                            VStack(alignment: .leading) {
                                Text(prompt.title)
                                Text(prompt.hint).font(.caption).foregroundStyle(.secondary)
                            }
                            Spacer()
                            if taken > 0 { Text("\(taken)").font(.caption.bold()).padding(6).background(.green.opacity(0.2), in: Circle()) }
                            Image(systemName: "camera")
                        }
                    }
                    .disabled(photos.count >= PlannerClient.maxPhotos || !UIImagePickerController.isSourceTypeAvailable(.camera))
                }
            } header: { Text("Guided photos (\(photos.count)/\(PlannerClient.maxPhotos))") } footer: {
                Text("Photos are linked to this scan and room. Add a note to say what matters (paint color, a crack, an outlet).")
            }
            if !photos.isEmpty {
                Section("Your photos") {
                    ForEach($photos) { $photo in
                        PhotoRow(photo: $photo)
                    }
                    .onDelete { photos.remove(atOffsets: $0) }
                }
            }
            if !room.objects.isEmpty {
                Section {
                    ForEach(room.objects, id: \.identifier) { object in
                        HStack {
                            Text(labels[object.identifier.uuidString] ?? String(describing: object.category).capitalized)
                            Spacer()
                            Text(sizeText(object.dimensions)).font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                        }
                    }
                } header: { Text(labelling ? "Furniture found (naming…)" : "Furniture found") } footer: {
                    Text(OnDeviceAI.unavailableReason ?? "Names written on this iPhone by Apple's on-device model.")
                }
            }
            Section {
                Button { upload(room) } label: { Text("Upload scan and \(photos.count) photo(s)").font(.headline).frame(maxWidth: .infinity) }
                    .buttonStyle(.borderedProminent).controlSize(.large)
                    .disabled(!client.canUpload || isUploading)
                Button("Scan again", role: .destructive) { photos = []; labels = [:]; scanner.reset() }
            }
        }
    }

    private func finishedView(_ id: Int) -> some View {
        VStack(spacing: 16) {
            Image(systemName: "icloud.and.arrow.up.fill").font(.system(size: 56)).foregroundStyle(.blue)
            Text("Uploaded").font(.title.bold())
            Text("Scan #\(id) is waiting in the editor under Scanning. Review it and promote it to Current; the photos come along.")
                .multilineTextAlignment(.center).foregroundStyle(.secondary)
            if client.info?.canSuggestMeasurements == true {
                NavigationLink("Add tape-measure notes") { MeasureNotesView() }.buttonStyle(.bordered)
            }
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

    private func sizeText(_ d: simd_float3) -> String {
        let w = Int((d.x * 39.3701).rounded()), dep = Int((d.z * 39.3701).rounded()), h = Int((d.y * 39.3701).rounded())
        return "\(w)×\(dep)×\(h) in"
    }

    // MARK: Actions

    /// Labels each object from its category and size (on-device model, or a simple rule).
    private func makeLabels(_ room: CapturedRoom) async {
        labelling = true
        defer { labelling = false }
        for object in room.objects {
            let d = object.dimensions
            let label = await OnDeviceAI.objectLabel(
                category: String(describing: object.category),
                widthIn: Int((d.x * 39.3701).rounded()), depthIn: Int((d.z * 39.3701).rounded()), heightIn: Int((d.y * 39.3701).rounded()))
            labels[object.identifier.uuidString] = label
        }
    }

    private func upload(_ room: CapturedRoom) {
        isUploading = true
        progress = 0
        Task {
            // Tag photos from their notes (which room, which topics), on-device or by keywords.
            let rooms = client.info?.roomLabel.map { [$0] } ?? []
            for i in photos.indices where !photos[i].note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                let r = await OnDeviceAI.tagPhoto(note: photos[i].note, prompt: photos[i].prompt, rooms: rooms)
                photos[i].roomTag = r.roomTag ?? photos[i].roomTag
                photos[i].tags = Array(Set(photos[i].tags + r.tags)).sorted()
            }
            do {
                finishedScanId = try await client.uploadScan(room: room, photos: photos, objectLabels: labels) { value in progress = value }
            } catch {
                errorMessage = error.localizedDescription
            }
            isUploading = false
        }
    }
}

/// One photo with its note. Tags come from the guided prompt, plus ones found in the note at upload.
struct PhotoRow: View {
    @Binding var photo: PlannerClient.Photo

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(uiImage: photo.image).resizable().scaledToFill().frame(width: 64, height: 64).clipped().cornerRadius(8)
            VStack(alignment: .leading, spacing: 6) {
                Text(photo.prompt).font(.caption.bold())
                TextField("Note (optional)", text: $photo.note, axis: .vertical)
                    .lineLimit(1...4)
                if !photo.tags.isEmpty {
                    Text(photo.tags.joined(separator: " · ")).font(.caption2).foregroundStyle(.secondary)
                }
            }
        }
    }
}

struct GuidedPrompt: Identifiable, Hashable {
    let id: String
    let title: String
    let hint: String
    let symbol: String
    let tags: [String]

    static let all: [GuidedPrompt] = [
        .init(id: "overview", title: "Room overview", hint: "From each corner, whole room in frame", symbol: "rectangle.3.group", tags: ["overview"]),
        .init(id: "walls", title: "Each wall, straight on", hint: "Shows paint color and what's on it", symbol: "square.split.2x1", tags: ["wall", "paint"]),
        .init(id: "windows", title: "Windows and trim", hint: "Casing, sills and any blinds", symbol: "window.casement", tags: ["window", "trim"]),
        .init(id: "doors", title: "Doors and openings", hint: "Including the swing direction", symbol: "door.left.hand.open", tags: ["door"]),
        .init(id: "outlets", title: "Outlets and switches", hint: "Close enough to see the cover style", symbol: "powerplug", tags: ["outlet", "switch"]),
        .init(id: "floor", title: "Floor", hint: "Material and color in daylight", symbol: "square.grid.3x3", tags: ["floor"]),
        .init(id: "ceiling", title: "Ceiling and lights", hint: "Fans, fixtures, beams", symbol: "lightbulb", tags: ["ceiling", "light"]),
        .init(id: "features", title: "Fireplace and built-ins", hint: "Mantel, shelves, radiators", symbol: "flame", tags: ["feature"]),
        .init(id: "furniture", title: "Furniture to keep", hint: "One photo per piece", symbol: "sofa", tags: ["furniture"]),
    ]
}

/// Camera for guided photos.
struct CameraPicker: UIViewControllerRepresentable {
    let onImage: (UIImage) -> Void
    let onDone: () -> Void

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
            if let image = info[.originalImage] as? UIImage { parent.onImage(image) }
            parent.onDone()
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) { parent.onDone() }
    }
}
