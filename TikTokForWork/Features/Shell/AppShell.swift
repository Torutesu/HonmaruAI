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
    @State private var showCapture = false
    @State private var captured: CaptureRequest?
    @State private var feedCardCount = 0
    @State private var feedCardIndex = 0

    var body: some View {
        ZStack {
            Theme.Colors.background.ignoresSafeArea()

            switch tab {
            case .home:
                FeedView(
                    showsChrome: false,
                    composeTick: composeTick,
                    onComposeConsumed: { composeTick = 0 },
                    captured: captured,
                    cardCount: $feedCardCount,
                    currentCardIndex: $feedCardIndex
                )
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
                    // The ＋ records; the transcript is editable before it is sent.
                    tab = .home
                    showCapture = true
                },
                onComposeText: {
                    // Long press is the way in for someone who cannot talk right
                    // now — same draft chain, no camera.
                    tab = .home
                    composeTick += 1
                },
                pendingCount: appState.pendingCount
            )
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
        let userID = appState.currentUser?.id
        let repository = appState.githubService.connection?.repository
        let sessionToken = SessionStore.sessionToken
        func isCurrentCapture() -> Bool {
            appState.currentUser?.id == userID &&
            appState.githubService.connection?.repository == repository &&
            SessionStore.sessionToken == sessionToken
        }
        var uploaded: String?
        if let video {
            let local = MediaStore.keep(video)
            // Compress before upload: R2 bills stored bytes, and a raw capture is
            // ~20x larger than a 960x540 export of the same talking-head clip.
            let toUpload = await MediaStore.compress(local ?? video)
            guard isCurrentCapture() else { return }
            if let base = appState.backendBaseURL {
                uploaded = try? await MediaUploader.upload(toUpload, to: base)
            }
            if uploaded == nil { uploaded = local?.absoluteString }
        }
        guard isCurrentCapture() else { return }
        captured = CaptureRequest(text: text, videoURL: uploaded)
    }

    private var homeTopBar: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 5) {
                HStack(spacing: 8) {
                    Text("Decisions")
                        .font(.title2.weight(.bold))
                        .foregroundStyle(Theme.Colors.textPrimary)
                    if appState.pendingCount > 0 {
                        Text("\(appState.pendingCount)")
                            .font(.caption.weight(.semibold))
                            .padding(.horizontal, 8)
                            .padding(.vertical, 4)
                            .foregroundStyle(Theme.Colors.accent)
                            .background(Theme.Colors.accent.opacity(0.09), in: Capsule())
                    }
                }
                HStack(spacing: 6) {
                    Circle().fill(connectionColor).frame(width: 6, height: 6)
                    Text(appState.isGuest ? String(localized: "Guest workspace") : (connectionLabel ?? String(localized: "Up to date")))
                        .font(.caption)
                        .foregroundStyle(Theme.Colors.textSecondary)
                    if feedCardCount > 1 {
                        Text("· \(feedCardIndex + 1) / \(feedCardCount)")
                            .font(.caption.monospacedDigit())
                            .foregroundStyle(Theme.Colors.textSecondary)
                    }
                }
            }
            Spacer()
            Button { tab = .you } label: {
                Text(String(appState.currentUser?.name.prefix(1) ?? "?"))
                    .font(.headline)
                    .foregroundStyle(Theme.Colors.accent)
                    .frame(width: 44, height: 44)
                    .background(Theme.Colors.accent.opacity(0.08), in: Circle())
                    .overlay(Circle().strokeBorder(Theme.Colors.accent.opacity(0.12), lineWidth: 1))
            }
            .buttonStyle(PressFeedbackStyle())
            .accessibilityLabel(Text("You"))
        }
        .padding(.horizontal, 24)
        .padding(.top, 8)
        .padding(.bottom, 16)
        .background(Theme.Colors.surface.ignoresSafeArea(edges: .top))
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
