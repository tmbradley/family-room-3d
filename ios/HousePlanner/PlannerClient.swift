import Foundation
import UIKit
import RoomPlan

/// Talks to the House Planner server with a pairing code only (no account, no session, no agent key).
/// A code has one purpose, chosen in the editor:
///  - scan: one RoomPlan scan of one room plus its guided photos. Order: RoomPlan JSON, USDZ, photos
///    (each: presign -> PUT -> complete), then import, which spends the code. Until it expires the
///    code can still send measurement suggestions for that room (they become proposals).
///  - model: one Object Capture model of one piece of furniture; import attaches it and spends the code.
@MainActor
final class PlannerClient: ObservableObject {
    enum CodeState: Equatable { case none, checking, valid(TokenInfo), invalid(String) }

    struct TokenInfo: Decodable, Equatable {
        let valid: Bool
        let spent: Bool
        let purpose: String          // "scan" | "model"
        let scope: String            // "room" | "new_room" | "placement"
        let roomId: Int?
        let placementId: Int?
        let roomLabel: String?
        let uploadsLeft: Int
        let canSuggestMeasurements: Bool
    }

    @Published private(set) var token: String?
    @Published private(set) var codeState: CodeState = .none

    /// Taken from the pairing link (https://<host>/scan?token=...); defaults to production.
    private(set) var apiBase = URL(string: "https://app-production-1828.up.railway.app")!

    /// The server allows 24 files per scan code: JSON + USDZ + up to 20 photos (+ slack).
    static let maxPhotos = 20

    var info: TokenInfo? { if case .valid(let i) = codeState { return i } else { return nil } }
    var canUpload: Bool { info.map { $0.valid && !$0.spent } ?? false }

    /// Universal link or custom URL: https://app-production-1828.up.railway.app/scan?token=XXXX-YYYY-ZZZZ
    func handle(url: URL) {
        guard let parts = URLComponents(url: url, resolvingAgainstBaseURL: true),
              let code = parts.queryItems?.first(where: { $0.name == "token" })?.value else { return }
        if let scheme = parts.scheme, let host = parts.host, scheme == "https" {
            var base = URLComponents(); base.scheme = scheme; base.host = host; base.port = parts.port
            if let b = base.url { apiBase = b }
        }
        setToken(code)
    }

    func setToken(_ code: String) {
        let trimmed = code.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        token = trimmed
        codeState = .checking
        Task { await refresh() }
    }

    func clear() { token = nil; codeState = .none }

    func refresh() async {
        guard let token else { return }
        do {
            let r: TokenInfo = try await post("/api/upload-tokens/validate", ["token": token])
            codeState = .valid(r)
        } catch {
            codeState = .invalid(error.localizedDescription)
        }
    }

    // MARK: Room scan

    struct Photo: Identifiable {
        let id = UUID()
        var image: UIImage
        var prompt: String
        var note: String
        var roomTag: String?
        var tags: [String]
    }

    /// Uploads the scan, its USDZ and photos, then imports it (spends the code). Returns the scan import id.
    func uploadScan(room: CapturedRoom, photos: [Photo], objectLabels: [String: String], progress: @escaping (Double) -> Void) async throws -> Int {
        guard let token, canUpload, info?.purpose == "scan" else { throw UploadError.invalidToken }

        // RoomPlan's own JSON (CapturedRoom is Codable) and a parametric USDZ model.
        let json = try JSONEncoder().encode(room)
        let usdzURL = FileManager.default.temporaryDirectory.appendingPathComponent("room-\(UUID().uuidString).usdz")
        try room.export(to: usdzURL, exportOptions: .parametric)
        defer { try? FileManager.default.removeItem(at: usdzURL) }
        let usdz = try Data(contentsOf: usdzURL)

        let selected = Array(photos.prefix(Self.maxPhotos))
        let total = Double(2 + selected.count + 1)
        var done = 0.0
        func step() { done += 1; progress(done / total) }

        let jsonUploadId = try await send(json, token: token, kind: "scan", format: "roomplan_json"); step()
        _ = try await send(usdz, token: token, kind: "scan", format: "usdz"); step()
        // Photos go up before the import: the import links every photo sent with this code to the scan.
        for p in selected {
            guard let jpeg = p.image.jpegData(compressionQuality: 0.8) else { continue }
            var meta: [String: Any] = ["prompt": String(p.prompt.prefix(120)), "tags": Array(p.tags.prefix(8))]
            if !p.note.isEmpty { meta["note"] = String(p.note.prefix(1000)) }
            if let tag = p.roomTag, !tag.isEmpty { meta["roomTag"] = String(tag.prefix(60)) }
            _ = try await send(jpeg, token: token, kind: "photo", format: "jpg", photo: meta); step()
        }

        let roomplan = try JSONSerialization.jsonObject(with: json)
        let r: ImportResponse = try await post("/api/scans/import", ["token": token, "uploadId": jsonUploadId, "roomplanData": roomplan, "objectLabels": objectLabels])
        step()
        // No refresh here: the screen keeps showing the result; "New code" starts over.
        return r.id
    }

    // MARK: Furniture model (Object Capture)

    /// Uploads a USDZ made on the phone and attaches it to the code's placement (spends the code).
    func uploadModel(fileURL: URL, label: String, progress: @escaping (Double) -> Void) async throws {
        guard let token, canUpload, info?.purpose == "model" else { throw UploadError.invalidToken }
        let data = try Data(contentsOf: fileURL)
        progress(0.1)
        let id = try await send(data, token: token, kind: "model", format: "usdz")
        progress(0.8)
        let _: ModelImportResponse = try await post("/api/models/import", ["token": token, "uploadId": id, "label": String(label.prefix(160))])
        progress(1)
    }

    // MARK: Measurement suggestions

    struct RoomOutline: Decodable {
        struct Wall: Decodable { let id: Int; let label: String; let lengthIn: Int; let heightIn: Int }
        struct Opening: Decodable { let id: Int; let wallId: Int; let type: String; let label: String?; let widthIn: Int; let sillIn: Int?; let headIn: Int? }
        let roomId: Int
        let label: String
        let ceilingIn: Int
        let walls: [Wall]
        let openings: [Opening]
    }

    struct Suggestion: Encodable, Hashable {
        let entityType: String // room | wall | opening
        let entityId: Int
        let field: String      // ceilingIn, heightIn, widthIn, sillIn, headIn, ...
        let valueIn: Int
        let note: String?
    }

    func roomOutline() async throws -> RoomOutline {
        guard let token else { throw UploadError.invalidToken }
        return try await post("/api/upload-tokens/room", ["token": token])
    }

    /// Sends suggestions; the server turns them into one pending proposal for Michael to approve.
    func submit(notes: String, suggestions: [Suggestion], method: String) async throws -> Int {
        guard let token else { throw UploadError.invalidToken }
        let list: [[String: Any]] = suggestions.map { s in
            var d: [String: Any] = ["entityType": s.entityType, "entityId": s.entityId, "field": s.field, "valueIn": s.valueIn]
            if let n = s.note { d["note"] = String(n.prefix(300)) }
            return d
        }
        let r: ProposalResponse = try await post("/api/suggestions", ["token": token, "notes": String(notes.prefix(4000)), "method": method, "suggestions": list])
        return r.id
    }

    // MARK: HTTP

    /// presign -> PUT to storage -> complete. Returns the upload id.
    private func send(_ data: Data, token: String, kind: String, format: String, photo: [String: Any]? = nil) async throws -> Int {
        let p: PresignResponse = try await post("/api/uploads/presigned", ["token": token, "kind": kind, "format": format])
        guard let url = URL(string: p.url) else { throw UploadError.invalidURL }
        var put = URLRequest(url: url)
        put.httpMethod = "PUT"
        put.setValue(p.contentType, forHTTPHeaderField: "Content-Type") // must match the signed content type
        let (_, response) = try await URLSession.shared.upload(for: put, from: data)
        guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else { throw UploadError.uploadFailed }
        var body: [String: Any] = ["token": token, "bytes": data.count]
        if let photo { body["photo"] = photo }
        let _: CompleteResponse = try await post("/api/uploads/\(p.uploadId)/complete", body)
        return p.uploadId
    }

    private func post<T: Decodable>(_ path: String, _ body: [String: Any]) async throws -> T {
        var request = URLRequest(url: apiBase.appendingPathComponent(path))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw UploadError.server("No response") }
        guard (200...299).contains(http.statusCode) else {
            let message = (try? JSONDecoder().decode(ServerError.self, from: data))?.message
            throw UploadError.server(message ?? "Server error \(http.statusCode)")
        }
        return try JSONDecoder().decode(T.self, from: data)
    }
}

private struct PresignResponse: Decodable { let uploadId: Int; let url: String; let contentType: String }
private struct CompleteResponse: Decodable { let uploadId: Int }
private struct ImportResponse: Decodable { let id: Int }
private struct ModelImportResponse: Decodable { let modelId: Int; let placementId: Int }
private struct ProposalResponse: Decodable { let id: Int }
private struct ServerError: Decodable { let error: String; let message: String? }

enum UploadError: LocalizedError {
    case invalidToken, invalidURL, uploadFailed
    case server(String)

    var errorDescription: String? {
        switch self {
        case .invalidToken: return "The pairing code is invalid, expired or for something else"
        case .invalidURL: return "Invalid upload URL"
        case .uploadFailed: return "Uploading a file failed"
        case .server(let message): return message
        }
    }
}
