import Foundation
import UIKit
import RoomPlan

/// Talks to the House Planner server with a pairing code (no account, no session).
/// Order: RoomPlan JSON, USDZ model, photos (each: presign -> PUT -> complete), then import,
/// which spends the code.
@MainActor
final class UploadManager: ObservableObject {
    enum CodeState: Equatable { case none, checking, valid(roomLabel: String), invalid(String) }

    @Published private(set) var token: String?
    @Published private(set) var codeState: CodeState = .none

    /// Taken from the App Clip invocation URL (https://<host>/scan?token=...); defaults to production.
    private(set) var apiBase = URL(string: "https://app-production-1828.up.railway.app")!

    static let maxPhotos = 10 // the server allows 12 files per code: JSON + USDZ + 10 photos

    var isTokenValid: Bool { if case .valid = codeState { return true } else { return false } }

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
        Task { await validate(trimmed) }
    }

    private func validate(_ code: String) async {
        do {
            let r: ValidateResponse = try await post("/api/upload-tokens/validate", ["token": code])
            codeState = .valid(roomLabel: r.roomLabel ?? "this room")
        } catch {
            codeState = .invalid(error.localizedDescription)
        }
    }

    func uploadScan(room: CapturedRoom, photos: [UIImage], progress: @escaping (Double) -> Void) async throws {
        guard let token, isTokenValid else { throw UploadError.invalidToken }

        // 1. RoomPlan's own JSON (CapturedRoom is Codable) and a parametric USDZ model.
        let json = try JSONEncoder().encode(room)
        let usdzURL = FileManager.default.temporaryDirectory.appendingPathComponent("room-\(UUID().uuidString).usdz")
        try room.export(to: usdzURL, exportOptions: .parametric)
        defer { try? FileManager.default.removeItem(at: usdzURL) }
        let usdz = try Data(contentsOf: usdzURL)

        let jpegs = photos.prefix(Self.maxPhotos).compactMap { $0.jpegData(compressionQuality: 0.8) }
        let total = Double(2 + jpegs.count + 1)
        var done = 0.0
        func step() { done += 1; progress(done / total) }

        let jsonUploadId = try await send(json, token: token, kind: "scan", format: "roomplan_json"); step()
        _ = try await send(usdz, token: token, kind: "scan", format: "usdz"); step()
        for jpeg in jpegs { _ = try await send(jpeg, token: token, kind: "photo", format: "jpg"); step() }

        // 2. Import for review in the editor (spends the code).
        let roomplan = try JSONSerialization.jsonObject(with: json)
        let _: ImportResponse = try await post("/api/scans/import", ["token": token, "uploadId": jsonUploadId, "roomplanData": roomplan])
        step()
        codeState = .invalid("Scan uploaded. Pair again from the editor to scan another room.")
    }

    /// presign -> PUT to storage -> complete. Returns the upload id.
    private func send(_ data: Data, token: String, kind: String, format: String) async throws -> Int {
        let p: PresignResponse = try await post("/api/uploads/presigned", ["token": token, "kind": kind, "format": format])
        guard let url = URL(string: p.url) else { throw UploadError.invalidURL }
        var put = URLRequest(url: url)
        put.httpMethod = "PUT"
        put.setValue(p.contentType, forHTTPHeaderField: "Content-Type") // must match the signed content type
        let (_, response) = try await URLSession.shared.upload(for: put, from: data)
        guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else { throw UploadError.uploadFailed }
        let _: CompleteResponse = try await post("/api/uploads/\(p.uploadId)/complete", ["token": token, "bytes": data.count])
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

private struct ValidateResponse: Decodable { let valid: Bool; let scope: String; let roomLabel: String?; let uploadsLeft: Int }
private struct PresignResponse: Decodable { let uploadId: Int; let url: String; let contentType: String }
private struct CompleteResponse: Decodable { let uploadId: Int }
private struct ImportResponse: Decodable { let id: Int }
private struct ServerError: Decodable { let error: String; let message: String? }

enum UploadError: LocalizedError {
    case invalidToken, invalidURL, uploadFailed
    case server(String)

    var errorDescription: String? {
        switch self {
        case .invalidToken: return "The pairing code is invalid or expired"
        case .invalidURL: return "Invalid upload URL"
        case .uploadFailed: return "Uploading a file failed"
        case .server(let message): return message
        }
    }
}
