import SwiftUI

struct RootView: View {
    @EnvironmentObject private var appState: AppState
    @ObservedObject private var updates = AppUpdateService.shared
    /// Signed out by a workspace's login rules: said once, on the way out.
    @State private var policyNotice = false

    var body: some View {
        Group {
            if appState.isAwaitingAIConsent {
                AIDataConsentView { appState.resolveAIConsent($0) }
            } else if appState.isBootstrapping {
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
        .modifier(AppUpdatePrompts(updates: updates, offerAllowed: appState.isAuthenticated && !appState.isBootstrapping))
        // A moment after launch, so it never lands on top of the first screen
        // while it is still arriving.
        .task {
            try? await Task.sleep(for: .seconds(2))
            await updates.check(backend: appState.backendBaseURL)
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
