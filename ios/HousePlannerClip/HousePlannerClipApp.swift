import SwiftUI

@main
struct HousePlannerClipApp: App {
    @StateObject private var uploads = UploadManager()

    var body: some Scene {
        WindowGroup {
            ScanView()
                .environmentObject(uploads)
                // App Clip invocation: https://app-production-1828.up.railway.app/scan?token=XXXX-YYYY-ZZZZ
                .onContinueUserActivity(NSUserActivityTypeBrowsingWeb) { activity in
                    if let url = activity.webpageURL { uploads.handle(url: url) }
                }
                .onOpenURL { url in uploads.handle(url: url) }
        }
    }
}
