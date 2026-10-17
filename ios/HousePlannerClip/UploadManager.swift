import Foundation
import UIKit
import RoomPlan

class UploadManager: ObservableObject {
    @Published var token: String?
    @Published var isTokenValid = false
    
    private let apiBase = "https://app-production-1828.up.railway.app"
    
    func setToken(_ token: String) {
        self.token = token
        validateToken()
    }
    
    private func validateToken() {
        guard let token = token else {
            isTokenValid = false
            return
        }
        
        Task {
            do {
                let url = URL(string: "\(apiBase)/api/upload-tokens/validate")!
                var request = URLRequest(url: url)
                request.httpMethod = "POST"
                request.setValue("application/json", forHTTPHeaderField: "Content-Type")
                request.httpBody = try JSONEncoder().encode(["token": token])
                
                let (data, response) = try await URLSession.shared.data(for: request)
                
                guard let httpResponse = response as? HTTPURLResponse,
                      httpResponse.statusCode == 200 else {
                    DispatchQueue.main.async {
                        self.isTokenValid = false
                    }
                    return
                }
                
                DispatchQueue.main.async {
                    self.isTokenValid = true
                }
            } catch {
                DispatchQueue.main.async {
                    self.isTokenValid = false
                }
            }
        }
    }
    
    func uploadScan(room: CapturedRoom, photos: [UIImage], progressHandler: @escaping (Double) -> Void) async throws {
        guard let token = token, isTokenValid else {
            throw UploadError.invalidToken
        }
        
        // Step 1: Export RoomPlan data to JSON and USDZ
        let (jsonData, usdzURL) = try await exportRoomPlanData(room: room)
        
        // Step 2: Get presigned URLs for uploads
        let totalUploads = 2 + photos.count // JSON + USDZ + photos
        var completed = 0
        
        // Upload RoomPlan JSON
        let jsonUploadInfo = try await getPresignedUpload(token: token, kind: "scan", format: "roomplan_json")
        try await uploadFile(data: jsonData, to: jsonUploadInfo.url)
        try await completeUpload(uploadId: jsonUploadInfo.uploadId, bytes: jsonData.count, token: token)
        completed += 1
        progressHandler(Double(completed) / Double(totalUploads))
        
        // Upload USDZ
        let usdzData = try Data(contentsOf: usdzURL)
        let usdzUploadInfo = try await getPresignedUpload(token: token, kind: "scan", format: "usdz")
        try await uploadFile(data: usdzData, to: usdzUploadInfo.url)
        try await completeUpload(uploadId: usdzUploadInfo.uploadId, bytes: usdzData.count, token: token)
        completed += 1
        progressHandler(Double(completed) / Double(totalUploads))
        
        // Upload photos
        for photo in photos {
            guard let jpegData = photo.jpegData(compressionQuality: 0.8) else { continue }
            let photoUploadInfo = try await getPresignedUpload(token: token, kind: "photo", format: "jpg")
            try await uploadFile(data: jpegData, to: photoUploadInfo.url)
            try await completeUpload(uploadId: photoUploadInfo.uploadId, bytes: jpegData.count, token: token)
            completed += 1
            progressHandler(Double(completed) / Double(totalUploads))
        }
        
        // Step 3: Parse the JSON and create scan import
        let roomplanDict = try JSONSerialization.jsonObject(with: jsonData) as? [String: Any]
        let importURL = URL(string: "\(apiBase)/api/scans/import")!
        var importRequest = URLRequest(url: importURL)
        importRequest.httpMethod = "POST"
        importRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
        
        let importBody: [String: Any] = [
            "token": token,
            "uploadId": jsonUploadInfo.uploadId,
            "roomplanData": roomplanDict ?? [:],
            "label": "Scanned Room"
        ]
        importRequest.httpBody = try JSONSerialization.data(withJSONObject: importBody)
        
        let (_, importResponse) = try await URLSession.shared.data(for: importRequest)
        guard let httpResponse = importResponse as? HTTPURLResponse,
              httpResponse.statusCode == 201 else {
            throw UploadError.serverError
        }
        
        // Step 4: Mark token as used
        try await markTokenUsed(token: token)
        
        progressHandler(1.0)
    }
    
    private func exportRoomPlanData(room: CapturedRoom) async throws -> (Data, URL) {
        // Export to JSON
        let jsonURL = FileManager.default.temporaryDirectory.appendingPathComponent("room.json")
        try room.export(to: jsonURL, exportOptions: .model)
        let jsonData = try Data(contentsOf: jsonURL)
        
        // Export to USDZ
        let usdzURL = FileManager.default.temporaryDirectory.appendingPathComponent("room.usdz")
        try room.export(to: usdzURL, exportOptions: .mesh)
        
        return (jsonData, usdzURL)
    }
    
    private func getPresignedUpload(token: String, kind: String, format: String, scanImportId: Int? = nil) async throws -> PresignedUploadResponse {
        let url = URL(string: "\(apiBase)/api/uploads/presigned")!
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        
        var body: [String: Any] = [
            "token": token,
            "kind": kind,
            "format": format
        ]
        if let scanImportId = scanImportId {
            body["scanImportId"] = scanImportId
        }
        
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        
        let (data, response) = try await URLSession.shared.data(for: request)
        
        guard let httpResponse = response as? HTTPURLResponse,
              httpResponse.statusCode == 200 else {
            throw UploadError.serverError
        }
        
        return try JSONDecoder().decode(PresignedUploadResponse.self, from: data)
    }
    
    private func uploadFile(data: Data, to urlString: String) async throws {
        guard let url = URL(string: urlString) else {
            throw UploadError.invalidURL
        }
        
        var request = URLRequest(url: url)
        request.httpMethod = "PUT"
        request.httpBody = data
        
        let (_, response) = try await URLSession.shared.data(for: request)
        
        guard let httpResponse = response as? HTTPURLResponse,
              (200...299).contains(httpResponse.statusCode) else {
            throw UploadError.uploadFailed
        }
    }
    
    private func completeUpload(uploadId: Int, bytes: Int, token: String) async throws {
        let url = URL(string: "\(apiBase)/api/uploads/\(uploadId)/complete")!
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(["token": token, "bytes": bytes])
        
        let (_, response) = try await URLSession.shared.data(for: request)
        
        guard let httpResponse = response as? HTTPURLResponse,
              httpResponse.statusCode == 200 else {
            throw UploadError.serverError
        }
    }
    
    private func markTokenUsed(token: String) async throws {
        let url = URL(string: "\(apiBase)/api/upload-tokens/1/complete")!
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(["token": token])
        
        let (_, response) = try await URLSession.shared.data(for: request)
        
        guard let httpResponse = response as? HTTPURLResponse,
              httpResponse.statusCode == 200 else {
            throw UploadError.serverError
        }
    }
}

struct PresignedUploadResponse: Codable {
    let uploadId: Int
    let url: String
    let bucketKey: String
    let expiresIn: Int
}

enum UploadError: LocalizedError {
    case invalidToken
    case invalidURL
    case uploadFailed
    case serverError
    
    var errorDescription: String? {
        switch self {
        case .invalidToken:
            return "The pairing code is invalid or expired"
        case .invalidURL:
            return "Invalid upload URL"
        case .uploadFailed:
            return "Failed to upload file"
        case .serverError:
            return "Server error occurred"
        }
    }
}
