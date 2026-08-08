import SwiftUI

/// Everything above the tab bar. Home carries the Cards / Classic switch; the
/// ＋ button asks the feed to open its compose flow rather than duplicating the
/// draft chain, which lives with `FeedViewModel`.
///
/// The screens are "Honmaru AI · Core App v3" in `docs/design-system.md`.
struct AppShell: View {
    @EnvironmentObject private var appState: AppState

    @State private var tab: AppTab = .home
    @State private var surface: HomeSurface = .cards
    @State private var composeTick = 0
    @State private var showCapture = false
    @State private var captured: CaptureRequest?

    var body: some View {
        ZStack {
            Theme.Colors.background.ignoresSafeArea()

            switch tab {
            case .home:
                switch surface {
                case .cards:
                    FeedView(showsChrome: false, composeTick: composeTick, captured: captured)
                case .classic:
                    // The old surface buries the decision; tapping a row is how
                    // you get back to it.
                    ClassicListView { surface = .cards }
                }
            case .you:
                YouView()
            }
        }
        .safeAreaInset(edge: .top, spacing: 0) {
            if tab == .home { homeTopBar }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            AppTabBar(selection: $tab) {
                // Compose always files a decision, so it returns to the cards.
                tab = .home
                surface = .cards
                showCapture = true
            }
        }
        .fullScreenCover(isPresented: $showCapture) {
            CaptureView { text in
                captured = CaptureRequest(text: text)
            }
            .environmentObject(appState)
        }
    }

    private var homeTopBar: some View {
        HStack {
            HomeSegmentedControl(selection: $surface, openCount: openCount)
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
            .accessibilityLabel(Text("あなた"))
        }
        .padding(.horizontal, Theme.Spacing.md)
        .padding(.vertical, Theme.Spacing.sm)
        .background(Theme.Colors.background.ignoresSafeArea(edges: .top))
    }

    private var openCount: Int {
        guard let user = appState.currentUser else { return 0 }
        return appState.cardService.cards(for: user.id).filter(\.isPending).count
    }
}

#Preview {
    AppShell()
        .environmentObject(AppState())
}
