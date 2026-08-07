import SwiftUI

@main
struct TikTokForWorkApp: App {
    @StateObject private var appState = AppState()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(appState)
                .environmentObject(appState.preferences)
        }
    }
}
