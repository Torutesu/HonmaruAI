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
                MainTabs(cardService: appState.cardService)
            } else {
                AuthView()
            }
        }
        .appBackground()
        .animation(.easeOut(duration: 0.2), value: appState.isAuthenticated)
        .animation(.easeOut(duration: 0.2), value: appState.isBootstrapping)
    }
}

// Feed ⇄ Chat: the AI-native decision feed and the classic Slack-style
// mode, side by side on the same backend.
@MainActor
struct MainTabs: View {
    @ObservedObject var cardService: DecisionCardService

    var body: some View {
        TabView {
            FeedView()
                .tabItem { Label("Feed", systemImage: "bolt.fill") }
            ChatTab()
                .tabItem { Label("Chat", systemImage: "bubble.left.and.bubble.right.fill") }
                .badge(cardService.totalChatUnseen)
        }
        .tint(Theme.Colors.accent)
    }
}

#Preview {
    RootView()
        .environmentObject(AppState())
}
