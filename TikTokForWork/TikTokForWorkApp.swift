import SwiftUI

@main
struct TikTokForWorkApp: App {
    @StateObject private var appState = AppState()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(appState)
                .environment(\.locale, appState.language.locale ?? Locale.autoupdatingCurrent)
                .preferredColorScheme(appState.appearance.colorScheme)
        }
    }
}
