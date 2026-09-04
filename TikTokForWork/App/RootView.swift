import SwiftUI

struct RootView: View {
    @EnvironmentObject private var appState: AppState

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
                AppShell()
            } else {
                OnboardingView()
            }
        }
        .appBackground()
        .animation(Motion.ease(0.2), value: appState.isAuthenticated)
        .animation(Motion.ease(0.2), value: appState.isBootstrapping)
    }
}

#Preview {
    RootView()
        .environmentObject(AppState())
}
