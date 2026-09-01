import SwiftUI

/// Everything above the tab bar. Home draws the cards; the ＋ button asks the
/// feed to open its compose flow rather than duplicating the draft chain, which
/// lives with `FeedViewModel`.
///
/// The screens are "Honmaru AI · Core App v3" in `docs/design-system.md`.
struct AppShell: View {
    @EnvironmentObject private var appState: AppState

    @State private var tab: AppTab = .home
    @State private var composeTick = 0

    var body: some View {
        ZStack {
            Theme.Colors.background.ignoresSafeArea()

            switch tab {
            case .home:
                FeedView(showsChrome: false, composeTick: composeTick)
            case .you:
                YouView()
            }
        }
        .safeAreaInset(edge: .top, spacing: 0) {
            if tab == .home { homeTopBar }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            AppTabBar(
                selection: $tab,
                onCompose: {
                    tab = .home
                    composeTick += 1
                },
                pendingCount: appState.pendingCount
            )
        }
    }

    private var homeTopBar: some View {
        HStack(spacing: Theme.Spacing.sm) {
            // Connection status — matches FeedView.topBar which is hidden in shell mode.
            HStack(spacing: 5) {
                Circle()
                    .fill(connectionColor)
                    .frame(width: 5, height: 5)
                if let label = connectionLabel {
                    Text(label)
                        .font(.system(size: 11))
                        .foregroundStyle(Theme.Colors.textTertiary)
                }
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel(Text(connectionLabel ?? String(localized: "Live")))

            Spacer()

            Button {
                tab = .you
            } label: {
                Text(String(appState.currentUser?.name.prefix(1) ?? "?"))
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Theme.Colors.textSecondary)
                    .frame(width: 28, height: 28)
                    .background(Theme.Colors.surfaceRaised)
                    .clipShape(Circle())
            }
            .accessibilityLabel(Text("You"))
        }
        .padding(.horizontal, Theme.Spacing.md)
        .padding(.vertical, Theme.Spacing.sm)
        .background(Theme.Colors.background.ignoresSafeArea(edges: .top))
    }

    private var connectionColor: Color {
        switch appState.connectionState {
        case .connected: Theme.Colors.approve
        case .connecting: Theme.Colors.interactive
        case .refused: Theme.Colors.reject
        case .offline: Theme.Colors.textTertiary
        }
    }

    private var connectionLabel: String? {
        switch appState.connectionState {
        case .connected: nil
        case .connecting: String(localized: "Reconnecting…")
        case .refused: String(localized: "No access")
        case .offline: String(localized: "Offline")
        }
    }
}

#Preview {
    AppShell()
        .environmentObject(AppState())
        .environmentObject(SubscriptionService.shared)
        .environmentObject(PushService.shared)
}
