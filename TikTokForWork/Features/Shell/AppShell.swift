import SwiftUI

/// Everything above the tab bar. Home draws the cards; the ＋ button asks the
/// feed to open its compose flow rather than duplicating the draft chain, which
/// lives with `FeedViewModel`.
///
/// The screens are "Honmaru AI · Core App v3" in `docs/design-system.md`.
struct AppShell: View {
    @EnvironmentObject private var appState: AppState

    @State private var tab: AppTab = .home
    /// Which half of your own work is on screen. Both halves are yours: the
    /// decisions waiting on you, and the ones you are waiting on. Only the first
    /// existed, so everything you sent vanished the moment you sent it.
    @State private var section: HomeSection = .inbox
    @State private var composeTick = 0
    @State private var showCapture = false
    @State private var captured: CaptureRequest?
    @State private var feedCardCount = 0
    @State private var feedCardIndex = 0
    @State private var showConnectGitHub = false

    var body: some View {
        ZStack {
            Theme.Colors.background.ignoresSafeArea()

            // The feed is kept alive rather than rebuilt on every tab switch.
            // A `switch` here destroyed it — and its view model, and the 30
            // second GitHub poll that view model owns — so every visit to Home
            // started another timer that the previous one never stopped.
            FeedView(
                showsChrome: false,
                composeTick: composeTick,
                captured: captured,
                cardCount: $feedCardCount,
                currentCardIndex: $feedCardIndex
            )
            .opacity(showsInbox ? 1 : 0)
            .allowsHitTesting(showsInbox)
            .accessibilityHidden(!showsInbox)

            if tab == .home, section == .sent {
                SentView()
            }

            if tab == .you {
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
                    // The ＋ records; the transcript is editable before it is sent.
                    tab = .home
                    section = .inbox
                    showCapture = true
                },
                onComposeText: {
                    // Long press is the way in for someone who cannot talk right
                    // now — same draft chain, no camera.
                    tab = .home
                    section = .inbox
                    composeTick += 1
                },
                pendingCount: appState.pendingCount
            )
        }
        .sheet(isPresented: $showConnectGitHub) {
            ConnectGitHubSheet(context: .settings)
                .environmentObject(appState)
                .presentationDetents([.medium, .large])
                .presentationBackground(Theme.Colors.surface)
                .presentationDragIndicator(.visible)
        }
        .fullScreenCover(isPresented: $showCapture) {
            CaptureView { text, video in
                showCapture = false
                Task { await handleCapture(text: text, video: video) }
            }
            .environmentObject(appState)
        }
    }

    /// Keeps the clip locally first, so a failed upload still plays back, then
    /// compresses and uploads it when a backend is configured. The decision
    /// routes on its text either way.
    private func handleCapture(text: String, video: URL?) async {
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        var uploaded: String?
        if let video {
            let local = MediaStore.keep(video)
            // Compress before upload: R2 bills stored bytes, and a raw capture is
            // ~20x larger than a 960x540 export of the same talking-head clip.
            let toUpload = await MediaStore.compress(local ?? video)
            if let base = appState.backendBaseURL {
                uploaded = try? await MediaUploader.upload(toUpload, to: base)
            }
            if uploaded == nil { uploaded = local?.absoluteString }
        }
        captured = CaptureRequest(text: text, videoURL: uploaded)
    }

    private var showsInbox: Bool { tab == .home && section == .inbox }

    private var homeTopBar: some View {
        VStack(spacing: Theme.Spacing.xs) {
            ZStack(alignment: .center) {
                HStack(spacing: Theme.Spacing.sm) {
                    // Connection status — matches FeedView.topBar which is hidden in shell mode.
                    // There is no socket when you are on your own, so a dot here
                    // would be reporting on nothing.
                    HStack(spacing: 5) {
                        if !appState.isGuest {
                            Circle()
                                .fill(connectionColor)
                                .frame(width: 5, height: 5)
                            if let label = connectionLabel {
                                Text(label)
                                    .font(.system(size: 11))
                                    .foregroundStyle(Theme.Colors.textTertiary)
                            }
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

                if appState.isGuest {
                    // Someone trying it on their own has no Sent list to switch
                    // to — there is nobody to have sent anything to — so the
                    // segmented control would be a control with one option.
                    localModeChip
                } else {
                    HomeSectionPicker(section: $section, stuckSentCount: appState.stuckSentCount)
                }
            }

            // Position in the stack, which only means anything in the feed.
            if showsInbox, feedCardCount > 1 {
                PageDots(count: feedCardCount, index: feedCardIndex)
            }
        }
        .padding(.horizontal, Theme.Spacing.md)
        .padding(.vertical, Theme.Spacing.sm)
        .background(Theme.Colors.background.ignoresSafeArea(edges: .top))
    }

    /// The way out of the one-person version, said where someone is looking.
    ///
    /// This existed, in a branch of the feed the shell never renders, so
    /// nobody had ever seen it.
    private var localModeChip: some View {
        Button {
            showConnectGitHub = true
        } label: {
            HStack(spacing: 5) {
                Text("On your own")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(Theme.Colors.textPrimary)
                Text("Connect GitHub")
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.Colors.interactive)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 5)
            .background(Theme.Colors.surfaceRaised)
            .clipShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Text("On your own. Connect GitHub to work with your team."))
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

/// The two halves of your own work.
enum HomeSection: Hashable {
    case inbox
    case sent
}

/// A two-up segmented control: `#eeeeee` track, white raised pill for the
/// selection, per the design system.
///
/// The dot on Sent is the only signal on this screen that something needs you
/// rather than the other way round — a request of yours that has gone quiet.
/// Without it, "Sent" is a tab nobody has a reason to open.
struct HomeSectionPicker: View {
    @Binding var section: HomeSection
    var stuckSentCount: Int = 0

    var body: some View {
        HStack(spacing: 2) {
            segment(.inbox, title: String(localized: "Inbox"))
            segment(.sent, title: String(localized: "Sent"), showsDot: stuckSentCount > 0)
        }
        .padding(2)
        .background(Theme.Colors.surfaceRaised)
        .clipShape(Capsule())
    }

    private func segment(_ value: HomeSection, title: String, showsDot: Bool = false) -> some View {
        Button {
            guard section != value else { return }
            Haptics.light()
            withAnimation(.easeOut(duration: 0.15)) { section = value }
        } label: {
            HStack(spacing: 4) {
                Text(title)
                    .font(.system(size: 12, weight: .medium))
                if showsDot {
                    Circle()
                        .fill(Theme.Colors.accent)
                        .frame(width: 5, height: 5)
                }
            }
            .foregroundStyle(section == value ? Theme.Colors.textPrimary : Theme.Colors.textTertiary)
            .padding(.horizontal, 14)
            .padding(.vertical, 5)
            .background {
                if section == value {
                    Capsule().fill(Theme.Colors.background)
                }
            }
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(section == value ? [.isSelected] : [])
        .accessibilityValue(showsDot ? Text("\(stuckSentCount) waiting on someone else") : Text(""))
    }
}
