import SwiftUI

@main
struct TikTokForWorkApp: App {
    @StateObject private var appState = AppState()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(appState)
                .environmentObject(SubscriptionService.shared)
                .environment(\.locale, appState.language.locale ?? Locale.autoupdatingCurrent)
                .preferredColorScheme(appState.appearance.colorScheme)
        }
        .onChange(of: scenePhase) { _, phase in
            // A socket dropped while the app was backgrounded produces no
            // receive-loop error to react to, so nothing would ever notice it
            // died. Coming back to the foreground is the signal.
            guard phase == .active else { return }
            appState.webSocketService.reconnectIfNeeded()
        }
    }
}
