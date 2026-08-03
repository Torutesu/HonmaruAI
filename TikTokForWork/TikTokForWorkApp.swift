import SwiftUI

@main
struct TikTokForWorkApp: App {
    @StateObject private var appState = AppState()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(appState)
                // Subscription state is observed directly by the paywall, the Customer
                // Center entry points, and any view that gates on `honmaruai Pro`.
                .environmentObject(appState.subscriptionService)
                .environmentObject(appState.routingQuota)
        }
    }
}
