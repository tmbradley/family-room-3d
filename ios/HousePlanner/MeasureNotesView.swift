import SwiftUI

/// Tape-measure notes for a room already in Current. The notes become structured suggestions
/// (on-device model, or keyword rules), the user reviews them, and they're sent as one proposal
/// that Michael approves in the editor. Nothing changes in the plan until he does.
struct MeasureNotesView: View {
    @EnvironmentObject var client: PlannerClient
    @State private var outline: PlannerClient.RoomOutline?
    @State private var notes = ""
    @State private var suggestions: [PlannerClient.Suggestion] = []
    @State private var method = "manual"
    @State private var working = false
    @State private var sentProposal: Int?
    @State private var errorMessage: String?

    var body: some View {
        Form {
            if let outline {
                Section {
                    TextField("e.g. Ceiling 8' 2\". Window 61 wide, sill 30.", text: $notes, axis: .vertical).lineLimit(3...10)
                    Button(working ? "Reading notes…" : "Turn notes into measurements") { Task { await extract(outline) } }
                        .disabled(notes.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || working)
                } header: { Text("Notes for \(outline.label)") } footer: {
                    Text(OnDeviceAI.unavailableReason ?? "Read on this iPhone by Apple's on-device model.")
                }
                if !suggestions.isEmpty {
                    Section("Suggestions (\(method == "on_device_model" ? "on-device model" : "keywords"))") {
                        ForEach(suggestions, id: \.self) { s in
                            HStack {
                                Text(describe(s, outline))
                                Spacer()
                                Text("\(s.valueIn) in").monospacedDigit().bold()
                            }
                        }
                        .onDelete { suggestions.remove(atOffsets: $0) }
                    }
                    Section {
                        Button("Send to Michael for approval") { Task { await send() } }.disabled(working)
                    }
                } else if method != "manual" && !working {
                    Text("No measurements recognised. Name the part (ceiling, window, door) and give a number.").foregroundStyle(.secondary)
                }
                if let id = sentProposal {
                    Label("Sent as proposal #\(id). Approve it in the editor to apply.", systemImage: "checkmark.circle.fill").foregroundStyle(.green)
                }
            } else if let errorMessage {
                Text(errorMessage).foregroundStyle(.orange)
            } else {
                ProgressView()
            }
        }
        .navigationTitle("Measurements")
        .task { await load() }
        .alert("Couldn't send", isPresented: Binding(get: { errorMessage != nil && outline != nil }, set: { if !$0 { errorMessage = nil } })) {
            Button("OK") { errorMessage = nil }
        } message: { Text(errorMessage ?? "") }
    }

    private func load() async {
        do { outline = try await client.roomOutline() } catch { errorMessage = error.localizedDescription }
    }

    private func extract(_ outline: PlannerClient.RoomOutline) async {
        working = true
        let r = await OnDeviceAI.measurementSuggestions(notes: notes, outline: outline)
        suggestions = r.suggestions.sorted { ($0.entityType, $0.entityId, $0.field) < ($1.entityType, $1.entityId, $1.field) }
        method = r.method
        working = false
    }

    private func send() async {
        working = true
        defer { working = false }
        do {
            sentProposal = try await client.submit(notes: notes, suggestions: suggestions, method: method)
            suggestions = []
        } catch { errorMessage = error.localizedDescription }
    }

    private func describe(_ s: PlannerClient.Suggestion, _ o: PlannerClient.RoomOutline) -> String {
        let field = ["ceilingIn": "ceiling height", "heightIn": "height", "widthIn": "width", "sillIn": "sill height", "headIn": "head height"][s.field] ?? s.field
        switch s.entityType {
        case "room": return "Room \(field)"
        case "wall": return "\(o.walls.first { $0.id == s.entityId }?.label ?? "Wall") \(field)"
        default:
            let p = o.openings.first { $0.id == s.entityId }
            return "\(p?.label ?? p?.type.replacingOccurrences(of: "_", with: " ").capitalized ?? "Opening") \(field)"
        }
    }
}
