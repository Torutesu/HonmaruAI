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
            AppTabBar(selection: $tab) {
                // The ＋ opens the feed's compose flow.
                tab = .home
                composeTick += 1
            }
        }
    }

    private var homeTopBar: some View {
        HStack {
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
}

#Preview {
    AppShell()
        .environmentObject(AppState())
}
