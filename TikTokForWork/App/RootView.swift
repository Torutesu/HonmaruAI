import SwiftUI

struct RootView: View {
    @EnvironmentObject private var appState: AppState
    /// Signed out by a workspace's login rules: said once, on the way out.
    @State private var policyNotice = false

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
        .animation(.easeOut(duration: 0.2), value: appState.isAuthenticated)
        .animation(.easeOut(duration: 0.2), value: appState.isBootstrapping)
        .onReceive(NotificationCenter.default.publisher(for: .sessionPolicyEnded)) { _ in
            guard appState.isAuthenticated else { return }
            appState.signOut()
            policyNotice = true
        }
        .alert("Sign in again", isPresented: $policyNotice) {
            Button("OK", role: .cancel) {}
        } message: {
            Text("This workspace's login rules ask you to sign in again.")
        }
    }
}

#Preview {
    RootView()
        .environmentObject(AppState())
}
