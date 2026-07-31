import SwiftUI

struct RootView: View {
    @EnvironmentObject private var appState: AppState
    @AppStorage("appearanceMode") private var appearanceRaw = AppearanceMode.system.rawValue

    private var appearance: AppearanceMode {
        AppearanceMode(rawValue: appearanceRaw) ?? .system
    }

    var body: some View {
        Group {
            if appState.isBootstrapping {
                VStack(spacing: Theme.Spacing.md) {
                    ProgressView()
                        .tint(Theme.Colors.accent)
                    Text("Restoring session…")
                        .font(Theme.TypeScale.caption)
                        .foregroundStyle(Theme.Colors.textTertiary)
                }
            } else if appState.isAuthenticated, appState.currentUser != nil {
                FeedView()
            } else {
                AuthView()
            }
        }
        .appBackground()
        .preferredColorScheme(appearance.colorScheme)
        .animation(.easeOut(duration: 0.2), value: appState.isAuthenticated)
        .animation(.easeOut(duration: 0.2), value: appState.isBootstrapping)
    }
}

#Preview {
    RootView()
        .environmentObject(AppState())
}
