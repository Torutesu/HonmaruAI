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
    @State private var pendingCapture: (text: String, video: URL?)?
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
                    // Classic settles its own decisions. Bouncing people to the
                    // Cards surface to act would undercut the comparison the
                    // screen exists to make.
                    ClassicListView { card, action in
                        Task { await resolve(card, action) }
                    }
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
        .fullScreenCover(isPresented: $showCapture, onDismiss: {
            // Hand the text over only once the cover is gone. Starting the draft
            // while it is still dismissing means the review sheet tries to
            // present against a controller that is on its way out, and SwiftUI
            // drops it — the tap looks like it did nothing.
            guard let pending = pendingCapture else { return }
            pendingCapture = nil
            Task { await handleCapture(pending.text, video: pending.video) }
        }) {
            CaptureView { text, video in
                pendingCapture = (text, video)
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

    /// Upload first, then draft. The clip has to have an address before the card
    /// that references it exists, or the card ships pointing at nothing.
    /// A failed upload is not fatal: the decision still routes, without video.
    private func handleCapture(_ text: String, video: URL?) async {
        guard let video else {
            captured = CaptureRequest(text: text)
            return
        }

        // Keep it locally first. Uploading is what lets someone else watch, but
        // it must never be the reason the clip is missing on this phone.
        let local = MediaStore.keep(video)

        var remote: String?
        if let local, let base = appState.backendBaseURL {
            remote = try? await MediaUploader.upload(local, to: base)
        }

        captured = CaptureRequest(text: text, videoURL: remote ?? local?.absoluteString)
    }

    private func resolve(_ card: DecisionCard, _ action: CardActionKind) async {
        guard let user = appState.currentUser else { return }
        _ = try? await appState.cardService.resolve(
            cardID: card.id,
            action: action,
            actorUserID: user.id,
            githubService: appState.githubService
        )
        appState.chatStore.recordDecision(card, action: action, by: user.name)
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
