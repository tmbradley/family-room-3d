import SwiftUI

@main
struct HousePlannerClipApp: App {
    @StateObject private var uploadManager = UploadManager()
    
    var body: some Scene {
        WindowGroup {
            ScanView()
                .environmentObject(uploadManager)
                .onContinueUserActivity(NSUserActivityTypeBrowsingWeb) { userActivity in
                    guard let url = userActivity.webpageURL else { return }
                    // Extract token from URL: https://app-production-1828.up.railway.app/scan?token=XXXX-YYYY-ZZZZ
                    if let components = URLComponents(url: url, resolvingAgainstBaseURL: true),
                       let token = components.queryItems?.first(where: { $0.name == "token" })?.value {
                        uploadManager.setToken(token)
                    }
                }
        }
    }
}
