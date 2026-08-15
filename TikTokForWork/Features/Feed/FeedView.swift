import SwiftUI

struct FeedView: View {
    /// When embedded in `AppShell` the surrounding chrome — the segmented
    /// control, the avatar, the tab bar — belongs to the shell, and this view
    /// draws only the cards. Standalone it draws its own, which is what the
    /// preview and any direct presentation still rely on.
    var showsChrome: Bool = true
    /// Incremented by the shell's ＋ button. The draft chain lives here with the
    /// view model, so the shell asks for it rather than rebuilding it.
    var composeTick: Int = 0
    /// What the capture screen came back with. Arrives already uploaded, so the
    /// draft chain starts the moment it is set.
    var captured: CaptureRequest?

    @EnvironmentObject private var appState: AppState
    @EnvironmentObject private var subscriptions: SubscriptionService
    @EnvironmentObject private var push: PushService
    @StateObject private var viewModel = FeedViewModel()
    @State private var aiPrompt = ""
    @State private var showAIInput = false
    @State private var showOrgGraph = false
    @State private var showMenu = false
    @State private var showConnectGitHub = false
    @State private var showPaywall = false
    @State private var connectContext: ConnectGitHubSheet.Context = .settings

    var body: some View {
        ZStack {
            Theme.Colors.background.ignoresSafeArea()

            if viewModel.cards.isEmpty {
                emptyState
            } else {
                ScrollView(.vertical) {
                    LazyVStack(spacing: 0) {
                        ForEach(viewModel.cards) { card in
                            DecisionCardView(
                                card: card,
                                linkedRepository: appState.githubService.linkedRepository,
                                isGitHubConnected: appState.githubService.isConnected,
                                onAction: { action in
                                    Task {
                                        await viewModel.handle(action: action, for: card, appState: appState)
                                    }
                                },
                                onShowDetails: {
                                    viewModel.detailCard = card
                                }
                            )
                            .containerRelativeFrame(.vertical)
                            .id(card.id)
                        }
                    }
                    .scrollTargetLayout()
                }
                .scrollTargetBehavior(.paging)
                .scrollPosition(id: $viewModel.scrollPosition)
                .scrollIndicators(.hidden)
                .task { await syncConnectors() }
                .refreshable { await syncConnectors() }
            }

            if viewModel.isProcessing {
                ProcessingOverlay(message: viewModel.processingMessage)
            }

            if viewModel.isDrafting {
                VStack {
                    DraftingBanner()
                    Spacer()
                }
            }

        }
        .safeAreaInset(edge: .top, spacing: 0) {
            if showsChrome { topBar }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if showsChrome { bottomChrome }
        }
        .onChange(of: composeTick) { _, _ in
            showAIInput = true
        }
        .onChange(of: push.pendingCardID) { _, cardID in
            guard let cardID else { return }
            viewModel.focus(cardID: cardID)
            push.pendingCardID = nil
        }
        .onChange(of: captured) { _, request in
            guard let request else { return }
            viewModel.beginDraft(request.text, priority: .medium, appState: appState, videoURL: request.videoURL)
        }
        .animation(.easeOut(duration: 0.2), value: viewModel.isDrafting)
        .onAppear {
            guard let user = appState.currentUser else { return }
            viewModel.bind(
                to: appState.cardService,
                user: user,
                githubService: appState.githubService
            )
            Task { await viewModel.syncGitHub() }
        }
        .sheet(isPresented: $showOrgGraph) {
            OrgGraphView()
                .environmentObject(appState)
        }
        .sheet(isPresented: $showAIInput) {
            AIInputSheet(
                prompt: $aiPrompt,
                isAIConfigured: appState.aiService.isConfigured,
                onSubmit: { text, priority in
                    viewModel.beginDraft(text, priority: priority, appState: appState)
                }
            )
            .presentationDetents([.medium, .large])
            .presentationBackground(Theme.Colors.surface)
            .presentationDragIndicator(.visible)
        }
        .sheet(item: $viewModel.reviewDraft) { draft in
            DraftReviewSheet(draft: draft) { finalDraft in
                Task {
                    await viewModel.sendDraft(finalDraft, appState: appState)
                    aiPrompt = ""
                }
            }
            .presentationDetents([.medium, .large])
            .presentationBackground(Theme.Colors.surface)
            .presentationDragIndicator(.visible)
        }
        .sheet(item: $viewModel.detailCard) { card in
            CardDetailSheet(card: card)
                .presentationDetents([.medium, .large])
        }
        .sheet(item: $viewModel.reviseCard) { card in
            ReviseSheet(card: card) { note in
                Task {
                    await viewModel.completeRevision(for: card, note: note, appState: appState)
                }
            }
        }
        .sheet(isPresented: $showConnectGitHub) {
            ConnectGitHubSheet(context: connectContext)
                .environmentObject(appState)
                .presentationDetents([.medium, .large])
                .presentationBackground(Theme.Colors.surface)
                .presentationDragIndicator(.visible)
        }
        .sheet(isPresented: $showPaywall) {
            ProPaywallSheet()
                .environmentObject(subscriptions)
        }
        .sheet(item: $viewModel.delegateCard) { card in
            DelegatePickerSheet(
                card: card,
                currentUserID: appState.currentUser?.id ?? ""
            ) { user in
                Task {
                    await viewModel.completeDelegate(for: card, to: user, appState: appState)
                }
            }
            .environmentObject(appState)
        }
        .confirmationDialog("Account", isPresented: $showMenu, titleVisibility: .hidden) {
            Button("Organization") { showOrgGraph = true }
            if !appState.githubService.isConnected {
                Button("Connect GitHub") {
                    connectContext = .settings
                    showConnectGitHub = true
                }
            }
            Button("Sign out", role: .destructive) { disconnect() }
            Button("Cancel", role: .cancel) {}
        }
        .alert("Error", isPresented: errorBinding) {
            Button("OK", role: .cancel) { viewModel.errorMessage = nil }
        } message: {
            Text(viewModel.errorMessage ?? "")
        }
    }

    private var errorBinding: Binding<Bool> {
        Binding(
            get: { viewModel.errorMessage != nil },
            set: { if !$0 { viewModel.errorMessage = nil } }
        )
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

    private var topBar: some View {
        HStack(alignment: .center) {
            HStack(spacing: 6) {
                Circle()
                    .fill(connectionColor)
                    .frame(width: 5, height: 5)
                Text(appState.currentUser?.name ?? "")
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(Theme.Colors.textPrimary)
                // The dot alone used to claim "live" whether or not the socket
                // was, so a state that is not connected says what it is.
                if let label = connectionLabel {
                    Text(label)
                        .font(.system(size: 11))
                        .foregroundStyle(Theme.Colors.textTertiary)
                }
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel(Text(connectionLabel ?? String(localized: "Live")))

            Spacer()

            if viewModel.cards.count > 1 {
                PageDots(count: viewModel.cards.count, index: viewModel.currentIndex)
            }

            Spacer()

            Button { showMenu = true } label: {
                Image(systemName: "ellipsis")
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(Theme.Colors.textSecondary)
                    .frame(width: 32, height: 32)
            }
        }
        .padding(.horizontal, Theme.Spacing.screen)
        .padding(.top, Theme.Spacing.sm)
        .padding(.bottom, Theme.Spacing.md)
        .background(
            Theme.Colors.background
                .ignoresSafeArea(edges: .top)
        )
    }

    private var bottomChrome: some View {
        VStack(spacing: Theme.Spacing.sm) {
            if viewModel.quotaExceeded {
                quotaNotice
            }

            if let repo = appState.githubService.connection?.repository {
                Text(repo)
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(Theme.Colors.textTertiary)
                    .lineLimit(1)
            } else {
                Button {
                    connectContext = .settings
                    showConnectGitHub = true
                } label: {
                    Text("Local mode · Connect GitHub")
                        .font(.system(size: 10, design: .monospaced))
                        .foregroundStyle(Theme.Colors.textTertiary)
                        .lineLimit(1)
                }
            }

            ComposeBar(placeholder: "Tell your AI") {
                showAIInput = true
            }
        }
        .padding(.horizontal, Theme.Spacing.screen)
        .padding(.top, Theme.Spacing.sm)
        .padding(.bottom, Theme.Spacing.md)
        .background(
            Theme.Colors.background
                .ignoresSafeArea(edges: .bottom)
        )
    }

    /// A single quiet line shown after a draft came back on the keyword fallback
    /// because the free daily AI quota ran out. Tapping it opens the paywall;
    /// tapping the ✕ dismisses it. It is deliberately not an alert — it must not
    /// interrupt or repeat.
    private var quotaNotice: some View {
        HStack(spacing: Theme.Spacing.sm) {
            Button {
                viewModel.quotaExceeded = false
                showPaywall = true
            } label: {
                HStack(spacing: 4) {
                    Text("You've used today's AI routing.")
                        .foregroundStyle(Theme.Colors.textTertiary)
                    Text("Upgrade")
                        .foregroundStyle(Theme.Colors.accent)
                }
                .font(.system(size: 11))
                .lineLimit(1)
            }
            .buttonStyle(.plain)

            Button {
                viewModel.quotaExceeded = false
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(Theme.Colors.textTertiary)
            }
            .buttonStyle(.plain)
        }
    }

    private var emptyState: some View {
        VStack(spacing: Theme.Spacing.sm) {
            Text(String(localized: "No decisions yet. Tell your AI something, or wait for a teammate."))
                .font(Theme.TypeScale.caption)
                .foregroundStyle(Theme.Colors.textTertiary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, Theme.Spacing.md)
        }
    }

    private func disconnect() {
        appState.signOut()
    }

    private func syncConnectors() async {
        guard let user = appState.currentUser,
              let repository = appState.githubService.connection?.repository,
              let base = appState.backendBaseURL else { return }
        await ConnectorService.syncAll(
            orgId: repository,
            userId: user.id,
            readerLanguage: appState.readerLanguageCode,
            backendBaseURL: base
        )
    }
}

#Preview {
    FeedView()
        .environmentObject(AppState())
        .environmentObject(SubscriptionService.shared)
}
