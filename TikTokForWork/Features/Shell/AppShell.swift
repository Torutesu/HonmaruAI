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

    var body: some View {
        ZStack {
            Theme.Colors.background.ignoresSafeArea()

            switch tab {
            case .home:
                FeedView(showsChrome: false, composeTick: composeTick, captured: captured)
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
