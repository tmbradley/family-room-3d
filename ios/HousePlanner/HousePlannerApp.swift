import SwiftUI

@main
struct HousePlannerApp: App {
    @StateObject private var client = PlannerClient()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(client)
                // Universal link from the pairing QR code: https://app-production-1828.up.railway.app/scan?token=...
                .onContinueUserActivity(NSUserActivityTypeBrowsingWeb) { activity in
                    if let url = activity.webpageURL { client.handle(url: url) }
                }
                .onOpenURL { url in client.handle(url: url) }
        }
    }
}
