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
    @State private var showComposeOptions = false
    @State private var captureMode: CaptureMode = .dictation
    @State private var uploadError: String?
    @State private var pendingCapture: (text: String, video: URL?)?
    @State private var uploadFallback: CaptureRequest?
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
                    // Make typing, on-device dictation and silent video discoverable.
                    tab = .home
                    showComposeOptions = true
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
        .fullScreenCover(isPresented: $showCapture, onDismiss: {
            guard let request = pendingCapture else { return }
            pendingCapture = nil
            Task { await handleCapture(text: request.text, video: request.video) }
        }) {
            CaptureView(mode: captureMode) { text, video in
                pendingCapture = (text, video)
                showCapture = false
            }
            .environmentObject(appState)
        }
        .confirmationDialog("New request", isPresented: $showComposeOptions, titleVisibility: .visible) {
            Button("Write a request") { composeTick += 1 }
            Button("Dictate request") { captureMode = .dictation; showCapture = true }
            Button("Record silent video") { captureMode = .video; showCapture = true }
            Button("Cancel", role: .cancel) { }
        }
        .alert("Video upload failed", isPresented: Binding(get: { uploadError != nil }, set: { if !$0 { uploadError = nil } })) {
            Button("OK") {
                uploadError = nil
                captured = uploadFallback
                uploadFallback = nil
            }
        } message: { Text(uploadError ?? "") }
        .onChange(of: appState.activeSessionID) { _, _ in
            pendingCapture = nil
            uploadFallback = nil
            uploadError = nil
            captured = nil
        }
    }

    /// Compresses and uploads the clip; a failed upload preserves the text draft
    /// without attaching a device-local URL that teammates cannot open.
    private func handleCapture(text: String, video: URL?) async {
        let generation = appState.activeSessionID
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        var uploaded: String?
        if let video {
            let local = MediaStore.keep(video)
            // Compress before upload: R2 bills stored bytes, and a raw capture is
            // ~20x larger than a 960x540 export of the same talking-head clip.
            let toUpload = await MediaStore.compress(local ?? video)
            guard generation == appState.activeSessionID else { return }
            if let base = appState.backendBaseURL {
                uploaded = try? await MediaUploader.upload(toUpload, to: base)
            }
            guard generation == appState.activeSessionID else { return }
            if uploaded == nil {
                uploadFallback = CaptureRequest(text: text, videoURL: nil)
                uploadError = String(localized: "Your video could not be uploaded. Your text has been kept; try again without video.")
                // Never share a device-local file URL with a teammate.
                return
            }
        }
        guard generation == appState.activeSessionID else { return }
        captured = CaptureRequest(text: text, videoURL: uploaded)
    }

    private var homeTopBar: some View {
        ZStack(alignment: .center) {
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

            if feedCardCount > 1 {
                PageDots(count: feedCardCount, index: feedCardIndex)
            }
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
