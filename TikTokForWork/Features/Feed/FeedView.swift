import SwiftUI

struct FeedView: View {
    @EnvironmentObject private var appState: AppState
    @StateObject private var viewModel = FeedViewModel()
    @State private var aiPrompt = ""
    @State private var showAIInput = false
    @State private var showUserSwitcher = false
    @State private var showOrgGraph = false

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
                .animation(.easeOut(duration: 0.2), value: viewModel.cards.count)
            }

            VStack {
                topBar
                Spacer()
                bottomBar
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
        .alert("Error", isPresented: errorBinding) {
            Button("OK", role: .cancel) {
                viewModel.errorMessage = nil
            }
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
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 2) {
                if let user = appState.currentUser {
                    Button {
                        showUserSwitcher = true
                    } label: {
                        HStack(spacing: 4) {
                            Circle()
                                .fill(appState.webSocketService.isConnected ? Theme.Colors.approve : Theme.Colors.textTertiary)
                                .frame(width: 6, height: 6)
                            Text(user.name)
                                .font(.system(size: 15, weight: .medium))
                                .foregroundStyle(Theme.Colors.textPrimary)
                            Image(systemName: "chevron.down")
                                .font(.system(size: 10, weight: .medium))
                                .foregroundStyle(Theme.Colors.textTertiary)
                        }
                    }

                    if let repo = appState.githubService.connection?.repository {
                        Text(repo)
                            .font(.system(size: 11, design: .monospaced))
                            .foregroundStyle(Theme.Colors.textTertiary)
                            .lineLimit(1)
                    }
                }
            }

            Spacer()

            Button {
                showOrgGraph = true
            } label: {
                Image(systemName: "point.3.connected.trianglepath.dotted")
                    .font(.system(size: 14))
                    .foregroundStyle(Theme.Colors.textTertiary)
            }
            .padding(.trailing, Theme.Spacing.sm)

            VStack(alignment: .trailing, spacing: 2) {
                if let position = viewModel.positionLabel {
                    Text(position)
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(Theme.Colors.textTertiary)
                }

                if viewModel.pendingCount > 0 {
                    Text("\(viewModel.pendingCount) pending")
                        .font(.system(size: 11))
                        .foregroundStyle(Theme.Colors.textSecondary)
                }
            }
        }
        .padding(.horizontal, Theme.Spacing.screen)
        .padding(.top, 12)
    }

    private var bottomBar: some View {
        HStack(spacing: Theme.Spacing.md) {
            Button {
                showAIInput = true
            } label: {
                Text("Message your AI")
                    .font(.system(size: 15))
                    .foregroundStyle(Theme.Colors.textSecondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, Theme.Spacing.md)
                    .padding(.vertical, 14)
                    .background(Theme.Colors.surfaceRaised)
                    .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
            }

            Button {
                disconnect()
            } label: {
                Image(systemName: "rectangle.portrait.and.arrow.right")
                    .font(.system(size: 14))
                    .foregroundStyle(Theme.Colors.textTertiary)
                    .frame(width: 44, height: 44)
            }
        }
        .padding(.horizontal, Theme.Spacing.screen)
        .padding(.bottom, Theme.Spacing.lg)
    }

    private var emptyState: some View {
        Text("Nothing pending")
            .font(.system(size: 15))
            .foregroundStyle(Theme.Colors.textSecondary)
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
