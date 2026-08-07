import SwiftUI

struct FeedView: View {
    @EnvironmentObject private var appState: AppState
    @StateObject private var viewModel = FeedViewModel()
    @State private var aiPrompt = ""
    @State private var showAIInput = false
    @State private var showOrgGraph = false
    @State private var showMenu = false
    @State private var inviteCode: String?

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
                                linkedRepository: "",
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
            topBar
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            bottomChrome
        }
        .animation(.easeOut(duration: 0.2), value: viewModel.isDrafting)
        .onAppear {
            guard let user = appState.currentUser else { return }
            viewModel.bind(to: appState.cardService, user: user)
        }
        .sheet(isPresented: $showOrgGraph) {
            OrgGraphView()
        }
        .sheet(isPresented: $showAIInput) {
            AIInputSheet(
                prompt: $aiPrompt,
                isAIConfigured: true,
                onSubmit: { text, priority in
                    viewModel.sendInstruction(text, priority: priority, appState: appState)
                    aiPrompt = ""
                }
            )
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
        .sheet(item: $viewModel.delegateCard) { card in
            DelegatePickerSheet(
                card: card,
                currentUserID: appState.currentUser?.id ?? ""
            ) { user in
                Task {
                    await viewModel.completeDelegate(for: card, to: user, appState: appState)
                }
            }
        }
        .confirmationDialog("Account", isPresented: $showMenu, titleVisibility: .hidden) {
            Button("Organization") { showOrgGraph = true }
            Button("Invite a teammate") { createInvite() }
            Button("Sign out", role: .destructive) { disconnect() }
            Button("Cancel", role: .cancel) {}
        }
        .alert(
            "Invite code",
            isPresented: Binding(
                get: { inviteCode != nil },
                set: { if !$0 { inviteCode = nil } }
            )
        ) {
            Button("OK", role: .cancel) { inviteCode = nil }
        } message: {
            Text(inviteCode ?? "")
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

    private var topBar: some View {
        HStack(alignment: .center) {
            Button { showMenu = true } label: {
                HStack(spacing: 6) {
                    Circle()
                        .fill(appState.webSocketService.isConnected ? Theme.Colors.approve : Theme.Colors.textTertiary)
                        .frame(width: 5, height: 5)
                    Text(appState.currentUser?.name ?? "")
                        .font(.system(size: 15, weight: .medium))
                        .foregroundStyle(Theme.Colors.textPrimary)
                    Image(systemName: "chevron.down")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(Theme.Colors.textTertiary)
                }
            }

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
            if let orgName = appState.orgName {
                Text(orgName)
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(Theme.Colors.textTertiary)
                    .lineLimit(1)
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

    private var emptyState: some View {
        VStack(spacing: Theme.Spacing.sm) {
            Text("Tell your AI what you need")
                .font(.system(size: 17, weight: .medium))
                .foregroundStyle(Theme.Colors.textPrimary)
            Text("Decisions will show up here")
                .font(Theme.TypeScale.caption)
                .foregroundStyle(Theme.Colors.textTertiary)
            Text("Use Tell your AI below to route one")
                .font(Theme.TypeScale.micro)
                .foregroundStyle(Theme.Colors.textTertiary)
                .padding(.top, Theme.Spacing.xs)
        }
    }

    private func disconnect() {
        appState.signOut()
    }

    private func createInvite() {
        Task {
            inviteCode = await appState.createInviteCode()
        }
    }
}

#Preview {
    FeedView()
        .environmentObject(AppState())
}
