import SwiftUI

struct FeedView: View {
    @EnvironmentObject private var appState: AppState
    @StateObject private var viewModel = FeedViewModel()
    @State private var aiPrompt = ""
    @State private var showAIInput = false
    @State private var showUserSwitcher = false
    @State private var showOrgGraph = false
    @State private var showMenu = false

    var body: some View {
        ZStack {
            Theme.Colors.background.ignoresSafeArea()

            if viewModel.cards.isEmpty {
                emptyState
            } else {
                TabView(selection: $viewModel.currentIndex) {
                    ForEach(Array(viewModel.cards.enumerated()), id: \.element.id) { index, card in
                        DecisionCardView(
                            card: card,
                            onAction: { action in
                                Task {
                                    await viewModel.handle(action: action, for: card, appState: appState)
                                }
                            }
                        )
                        .tag(index)
                    }
                }
                .tabViewStyle(.page(indexDisplayMode: .never))
                .ignoresSafeArea()
            }

            VStack(spacing: 0) {
                topBar
                Spacer()
                bottomChrome
            }

            if viewModel.isProcessing {
                ProcessingOverlay(message: viewModel.processingMessage)
            }
        }
        .onAppear {
            guard let user = appState.currentUser else { return }
            viewModel.bind(to: appState.cardService, user: user)
        }
        .sheet(isPresented: $showUserSwitcher) {
            UserSwitcherSheet { user in
                Task {
                    appState.currentUser = user.user
                    try? await appState.webSocketService.connect(
                        urlString: appState.relayURL,
                        userId: user.user.id
                    )
                    viewModel.bind(to: appState.cardService, user: user.user)
                }
            }
            .environmentObject(appState)
        }
        .sheet(isPresented: $showOrgGraph) {
            OrgGraphView()
        }
        .sheet(isPresented: $showAIInput) {
            AIInputSheet(prompt: $aiPrompt) { text in
                Task {
                    await viewModel.sendInstruction(text, appState: appState)
                    aiPrompt = ""
                    showAIInput = false
                }
            }
            .presentationDetents([.medium])
            .presentationBackground(Theme.Colors.surface)
            .presentationDragIndicator(.visible)
        }
        .confirmationDialog("Account", isPresented: $showMenu, titleVisibility: .hidden) {
            Button("Organization") { showOrgGraph = true }
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

    private var topBar: some View {
        HStack(alignment: .center) {
            Button { showUserSwitcher = true } label: {
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
        .padding(.top, 8)
    }

    private var bottomChrome: some View {
        VStack(spacing: Theme.Spacing.sm) {
            if let repo = appState.githubService.connection?.repository {
                Text(repo)
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(Theme.Colors.textTertiary)
                    .lineLimit(1)
            }

            ComposeBar(placeholder: "Ask your AI") {
                showAIInput = true
            }
        }
        .padding(.horizontal, Theme.Spacing.screen)
        .padding(.bottom, Theme.Spacing.lg)
        .background(
            Theme.Colors.background
                .opacity(0.94)
                .ignoresSafeArea(edges: .bottom)
        )
    }

    private var emptyState: some View {
        VStack(spacing: Theme.Spacing.sm) {
            Text("All clear")
                .font(.system(size: 17, weight: .medium))
                .foregroundStyle(Theme.Colors.textPrimary)
            Text("Nothing needs your decision")
                .font(Theme.TypeScale.caption)
                .foregroundStyle(Theme.Colors.textTertiary)
        }
    }

    private func disconnect() {
        appState.webSocketService.disconnect()
        appState.githubService.disconnect()
        appState.isAuthenticated = false
        appState.currentUser = nil
    }
}

#Preview {
    FeedView()
        .environmentObject(AppState())
}
