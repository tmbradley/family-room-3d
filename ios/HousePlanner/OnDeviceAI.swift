import Foundation
#if canImport(FoundationModels)
import FoundationModels
#endif

/// Small text tasks on the phone. Uses Apple's on-device Foundation Models (iOS 26, Apple
/// Intelligence on and the model downloaded) when available; otherwise falls back to plain rules,
/// so every feature still works on iOS 17-25 and on phones without Apple Intelligence.
/// Nothing here leaves the phone except the results the user chooses to send.
enum OnDeviceAI {
    /// True when the system language model can be used right now.
    static var isAvailable: Bool {
        #if canImport(FoundationModels)
        if #available(iOS 26.0, *) {
            if case .available = SystemLanguageModel.default.availability { return true }
        }
        #endif
        return false
    }

    /// Why the on-device model isn't used (for a small note in the UI), or nil if it is.
    static var unavailableReason: String? {
        #if canImport(FoundationModels)
        if #available(iOS 26.0, *) {
            switch SystemLanguageModel.default.availability {
            case .available: return nil
            case .unavailable(let reason): return "On-device model unavailable (\(String(describing: reason))); using simple rules."
            @unknown default: return "On-device model unavailable; using simple rules."
            }
        }
        #endif
        return "On-device model needs iOS 26 with Apple Intelligence; using simple rules."
    }

    // MARK: 1. Label for a scanned object

    /// A short description such as "Three-seat sofa, about 7 ft wide" from RoomPlan's category and size.
    static func objectLabel(category: String, widthIn: Int, depthIn: Int, heightIn: Int) async -> String {
        #if canImport(FoundationModels)
        if #available(iOS 26.0, *), isAvailable {
            do {
                let session = LanguageModelSession(instructions: """
                    You name pieces of furniture found by a room scanner. Reply with a short label of at most \
                    eight words, like "Three-seat sofa" or "Low media console". Use the size to pick the kind \
                    (for example a sofa over 100 inches wide and deep is likely a sectional). No brand names.
                    """)
                let r = try await session.respond(to: "Category: \(category). Width \(widthIn) in, depth \(depthIn) in, height \(heightIn) in.", generating: ObjectLabel.self)
                let label = r.content.label.trimmingCharacters(in: .whitespacesAndNewlines)
                if !label.isEmpty { return String(label.prefix(80)) }
            } catch { /* fall through to the rule */ }
        }
        #endif
        return fallbackLabel(category: category, widthIn: widthIn, depthIn: depthIn)
    }

    static func fallbackLabel(category: String, widthIn: Int, depthIn: Int) -> String {
        let name = category.prefix(1).uppercased() + category.dropFirst()
        let w = max(widthIn, depthIn), d = min(widthIn, depthIn)
        if category == "sofa" && w >= 90 && d >= 55 { return "Sectional, \(w)\" × \(d)\"" }
        return "\(name), \(w)\" × \(d)\""
    }

    // MARK: 2. Tag a photo from the user's note

    struct PhotoTags { var roomTag: String?; var tags: [String] }

    /// Picks which room the note talks about (from `rooms`) and a few topic tags (paint, outlet, trim, ...).
    static func tagPhoto(note: String, prompt: String, rooms: [String]) async -> PhotoTags {
        let text = "\(prompt). \(note)"
        #if canImport(FoundationModels)
        if #available(iOS 26.0, *), isAvailable, !note.trimmingCharacters(in: .whitespaces).isEmpty {
            do {
                let session = LanguageModelSession(instructions: """
                    You tag photos of a house. Given a photo's note, choose the room it shows from the list \
                    (or leave it empty if unclear) and up to five one- or two-word lowercase topic tags such as \
                    paint, trim, outlet, switch, floor, window, door, fireplace, ceiling, damage, furniture.
                    """)
                let r = try await session.respond(to: "Rooms: \(rooms.joined(separator: ", ")). Note: \(text)", generating: PhotoTagResult.self)
                let room = r.content.room.trimmingCharacters(in: .whitespaces)
                return PhotoTags(roomTag: room.isEmpty ? rooms.first : room, tags: Array(r.content.tags.prefix(5)))
            } catch { /* fall through */ }
        }
        #endif
        return fallbackTags(text: text, rooms: rooms)
    }

    static func fallbackTags(text: String, rooms: [String]) -> PhotoTags {
        let lower = text.lowercased()
        let room = rooms.first { lower.contains($0.lowercased()) } ?? rooms.first
        let vocabulary = ["paint", "trim", "baseboard", "outlet", "switch", "floor", "window", "door", "fireplace", "mantel", "ceiling", "light", "damage", "crack", "furniture", "rug"]
        return PhotoTags(roomTag: room, tags: Array(vocabulary.filter { lower.contains($0) }.prefix(5)))
    }

    // MARK: 3. Notes -> measurement suggestions

    /// Turns typed or dictated notes ("the left window is 61 wide, ceiling 109") into suggestions that
    /// point at real ids from the room outline. Only values that match a known wall/opening/room field
    /// are kept; Michael approves them in the editor.
    static func measurementSuggestions(notes: String, outline: PlannerClient.RoomOutline) async -> (suggestions: [PlannerClient.Suggestion], method: String) {
        #if canImport(FoundationModels)
        if #available(iOS 26.0, *), isAvailable {
            do {
                let catalog = outlineText(outline)
                let session = LanguageModelSession(instructions: """
                    You turn a homeowner's tape-measure notes into structured measurements. Only use the ids \
                    listed. Allowed targets: room ceilingIn; wall heightIn; opening widthIn, sillIn, headIn. \
                    Convert feet and inches to whole inches (8' 2" = 98). Skip anything you are not sure about.
                    """)
                let r = try await session.respond(to: "Room parts:\n\(catalog)\n\nNotes: \(notes)", generating: MeasurementList.self)
                let valid = r.content.items.compactMap { validate($0.entityType, $0.entityId, $0.field, $0.valueIn, $0.note, outline) }
                if !valid.isEmpty { return (Array(Set(valid)), "on_device_model") }
            } catch { /* fall through */ }
        }
        #endif
        return (keywordSuggestions(notes: notes, outline: outline), "keywords")
    }

    static func outlineText(_ o: PlannerClient.RoomOutline) -> String {
        var lines = ["room \(o.roomId) \"\(o.label)\": ceilingIn \(o.ceilingIn)"]
        for w in o.walls { lines.append("wall \(w.id) \"\(w.label)\": length \(w.lengthIn), heightIn \(w.heightIn)") }
        for p in o.openings { lines.append("opening \(p.id) \(p.type) \"\(p.label ?? p.type)\" on wall \(p.wallId): widthIn \(p.widthIn)") }
        return lines.joined(separator: "\n")
    }

    private static let allowed: [String: Set<String>] = ["room": ["ceilingIn"], "wall": ["heightIn"], "opening": ["widthIn", "sillIn", "headIn"]]

    static func validate(_ type: String, _ id: Int, _ field: String, _ value: Int, _ note: String?, _ o: PlannerClient.RoomOutline) -> PlannerClient.Suggestion? {
        guard allowed[type]?.contains(field) == true, (1...2000).contains(value) else { return nil }
        let exists = (type == "room" && id == o.roomId) || (type == "wall" && o.walls.contains { $0.id == id }) || (type == "opening" && o.openings.contains { $0.id == id })
        return exists ? PlannerClient.Suggestion(entityType: type, entityId: id, field: field, valueIn: value, note: note) : nil
    }

    /// Rule-based fallback: "ceiling 109", "window 61 wide", "door 30", "sill 36" (feet-inches understood).
    /// With several windows/doors it only fills one when there is exactly one of that type.
    static func keywordSuggestions(notes: String, outline o: PlannerClient.RoomOutline) -> [PlannerClient.Suggestion] {
        var out: [PlannerClient.Suggestion] = []
        let sentences = notes.lowercased().split(whereSeparator: { ".;\n".contains($0) }).map(String.init)
        for s in sentences {
            guard let value = inches(in: s) else { continue }
            if s.contains("ceiling") { out.append(.init(entityType: "room", entityId: o.roomId, field: "ceilingIn", valueIn: value, note: s)); continue }
            for (word, type) in [("window", "window"), ("door", "door"), ("opening", "open_span")] where s.contains(word) {
                let matches = o.openings.filter { $0.type == type }
                guard matches.count == 1, let m = matches.first else { continue }
                let field = s.contains("sill") ? "sillIn" : (s.contains("head") || s.contains("top")) ? "headIn" : "widthIn"
                out.append(.init(entityType: "opening", entityId: m.id, field: field, valueIn: value, note: s))
            }
        }
        return Array(Set(out))
    }

    /// First length in a phrase, in whole inches: 61, 61", 5'1", 5 ft 1 in, 5 feet.
    static func inches(in s: String) -> Int? {
        let ns = s as NSString
        let patterns = [#"(\d+)\s*(?:'|ft|feet|foot)\s*(\d+)?\s*(?:"|in|inch|inches)?"#, #"(\d+)\s*(?:"|in\b|inch|inches)?"#]
        for (i, p) in patterns.enumerated() {
            guard let re = try? NSRegularExpression(pattern: p), let m = re.firstMatch(in: s, range: NSRange(location: 0, length: ns.length)) else { continue }
            let a = Int(ns.substring(with: m.range(at: 1))) ?? 0
            if i == 0 {
                let b = m.range(at: 2).location != NSNotFound ? Int(ns.substring(with: m.range(at: 2))) ?? 0 : 0
                return a * 12 + b
            }
            return a > 0 ? a : nil
        }
        return nil
    }
}

#if canImport(FoundationModels)
@available(iOS 26.0, *)
@Generable
struct ObjectLabel {
    @Guide(description: "A short furniture label, at most eight words")
    var label: String
}

@available(iOS 26.0, *)
@Generable
struct PhotoTagResult {
    @Guide(description: "The room from the given list that the note is about, or an empty string")
    var room: String
    @Guide(description: "Up to five short lowercase topic tags")
    var tags: [String]
}

@available(iOS 26.0, *)
@Generable
struct MeasurementItem {
    @Guide(description: "room, wall or opening")
    var entityType: String
    @Guide(description: "The id from the list of room parts")
    var entityId: Int
    @Guide(description: "ceilingIn, heightIn, widthIn, sillIn or headIn")
    var field: String
    @Guide(description: "The measurement in whole inches")
    var valueIn: Int
    @Guide(description: "The words from the notes this came from")
    var note: String
}

@available(iOS 26.0, *)
@Generable
struct MeasurementList {
    @Guide(description: "Each measurement found in the notes")
    var items: [MeasurementItem]
}
#endif
