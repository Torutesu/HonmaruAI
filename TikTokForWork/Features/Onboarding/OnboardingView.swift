import SwiftUI

/// Guided first-run flow. Five screens, in order of persuasion:
/// value → how it works → try it (interactive swipe) → GitHub sign-in → identity.
/// Sign-in comes after the product has shown itself, and can be skipped —
/// the feed offers the connection again in context.
struct OnboardingView: View {
    @EnvironmentObject private var appState: AppState

    private enum Step: Int, CaseIterable {
        case welcome
        case routing
        case swipe
        case github
    }

    @State private var step: Step = .welcome

    // GitHub step
    @State private var selectedRepository: GitHubRepository?
    @State private var isSigningIn = false
    @State private var isConnecting = false
    @State private var isRefreshingRepos = false
    @State private var errorMessage: String?

    var body: some View {
        VStack(spacing: 0) {
            header
                .padding(.horizontal, Theme.Spacing.screen)
                .padding(.top, Theme.Spacing.sm)

            Group {
                switch step {
                case .welcome: welcomeStep
                case .routing: routingStep
                case .swipe: swipeStep
                case .github: githubStep
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .padding(.horizontal, Theme.Spacing.screen)
            .transition(.asymmetric(
                insertion: .move(edge: .trailing).combined(with: .opacity),
                removal: .move(edge: .leading).combined(with: .opacity)
            ))
            .id(step)
        }
        .appBackground()
        .animation(.easeOut(duration: 0.25), value: step)
    }

    // MARK: - Chrome

    private var header: some View {
        ZStack {
            PageDots(count: Step.allCases.count, index: step.rawValue)

            HStack {
                if step != .welcome {
                    Button(action: goBack) {
                        Image(systemName: "chevron.left")
                            .font(.system(size: 15, weight: .medium))
                            .foregroundStyle(Theme.Colors.textSecondary)
                            .frame(width: 32, height: 32)
                    }
                    .accessibilityLabel("Back")
                }
                Spacer()
            }
        }
        .frame(height: 32)
    }

    private func advance() {
        guard let next = Step(rawValue: step.rawValue + 1) else { return }
        errorMessage = nil
        step = next
    }

    private func goBack() {
        guard let previous = Step(rawValue: step.rawValue - 1) else { return }
        errorMessage = nil
        step = previous
    }

    // MARK: - 1. Welcome

    private var welcomeStep: some View {
        VStack(alignment: .leading, spacing: 0) {
            Spacer()

            AppLogo(size: 80)
                .padding(.bottom, Theme.Spacing.xl)

            Text("Decisions,\nnot messages")
                .font(.system(size: 44, weight: .semibold))
                .foregroundStyle(Theme.Colors.textPrimary)
                .lineSpacing(4)
                .tracking(-0.5)
                .padding(.bottom, Theme.Spacing.md)

            Text("A work feed where nothing needs reading twice. Your AI turns your team's asks, approvals, and tasks into cards you clear in seconds.")
                .font(.system(size: 16))
                .foregroundStyle(Theme.Colors.textSecondary)
                .lineSpacing(6)
                .fixedSize(horizontal: false, vertical: true)

            Spacer()
            Spacer()

            PrimaryButton(title: String(localized: "Get started")) {
                Haptics.light()
                advance()
            }
            .padding(.bottom, Theme.Spacing.xl)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: - 2. How it works

    private var routingStep: some View {
        VStack(alignment: .leading, spacing: 0) {
            stepTitle(
                "Talk only to your AI",
                subtitle: "No channels, no DMs, no inbox. Say what you need — the AIs handle who hears it, and how."
            )

            VStack(spacing: Theme.Spacing.sm) {
                routingRow(
                    icon: "person",
                    title: "You",
                    detail: "“Get the auth fix reviewed before Friday.”"
                )
                routingArrow
                routingRow(
                    icon: "sparkle",
                    title: "Your AI",
                    detail: "Reads intent, checks the org graph, picks who can decide."
                )
                routingArrow
                routingRow(
                    icon: "sparkle",
                    title: "Dana's AI",
                    detail: "Rewrites it as one clear decision, in Dana's context."
                )
                routingArrow
                routingRow(
                    icon: "person",
                    title: "Dana",
                    detail: "Sees a card. One tap: approved."
                )
            }
            .padding(.top, Theme.Spacing.lg)

            Spacer()

            PrimaryButton(title: String(localized: "Continue")) {
                Haptics.light()
                advance()
            }
            .padding(.bottom, Theme.Spacing.xl)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func routingRow(icon: String, title: LocalizedStringKey, detail: LocalizedStringKey) -> some View {
        HStack(alignment: .top, spacing: Theme.Spacing.md) {
            ZStack {
                Circle()
                    .fill(icon == "sparkle" ? Theme.Colors.accent.opacity(0.10) : Theme.Colors.surfaceRaised)
                    .frame(width: 32, height: 32)
                Image(systemName: icon)
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(icon == "sparkle" ? Theme.Colors.accent : Theme.Colors.textSecondary)
            }

            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(Theme.Colors.textPrimary)
                Text(detail)
                    .font(Theme.TypeScale.caption)
                    .foregroundStyle(Theme.Colors.textSecondary)
                    .lineSpacing(3)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
        .padding(Theme.Spacing.md)
        .background(Theme.Colors.background)
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.card))
        .overlay {
            RoundedRectangle(cornerRadius: Theme.Radius.card)
                .strokeBorder(Theme.Colors.border, lineWidth: 1)
        }
    }

    private var routingArrow: some View {
        Image(systemName: "arrow.down")
            .font(.system(size: 10, weight: .medium))
            .foregroundStyle(Theme.Colors.textTertiary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.leading, 40)
    }

    // MARK: - 3. Try it

    private var swipeStep: some View {
        OnboardingSwipeDemo {
            advance()
        }
    }

    // MARK: - 4. GitHub

    private var githubStep: some View {
        VStack(alignment: .leading, spacing: 0) {
            stepTitle(
                "Sign in with GitHub",
                subtitle: "Sign in with GitHub to reach your team. Your teammates are your repo's collaborators, and every approval becomes an Issue you can track."
            )

            VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
                if appState.githubService.hasToken {
                    repositoryPicker
                } else {
                    githubSignInButton
                }

                if appState.githubService.isConnected, let connection = appState.githubService.connection {
                    connectedBanner(connection)
                }

                if let errorMessage {
                    Text(errorMessage)
                        .font(Theme.TypeScale.label)
                        .foregroundStyle(Theme.Colors.reject)
                }
            }
            .padding(.top, Theme.Spacing.lg)

            Spacer()

            VStack(spacing: Theme.Spacing.sm) {
                PrimaryButton(
                    title: String(localized: "Enter"),
                    enabled: canConnectGitHub && !isConnecting && !isSigningIn
                ) {
                    connectGitHubAndEnter()
                }
                .overlay {
                    if isConnecting {
                        ProgressView().tint(Theme.Colors.background)
                    }
                }

                Button {
                    appState.activateGuestSession()
                } label: {
                    Text("Continue without signing in")
                        .font(Theme.TypeScale.label)
                        .foregroundStyle(Theme.Colors.textSecondary)
                }
                .disabled(isConnecting || isSigningIn)
            }
            .padding(.bottom, Theme.Spacing.xl)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .onAppear {
            if selectedRepository == nil,
               let repository = appState.githubService.connection?.repository {
                selectedRepository = appState.githubService.repositories.first { $0.fullName == repository }
            }
            if appState.githubService.hasToken, appState.githubService.repositories.isEmpty {
                refreshRepositories()
            }
        }
    }

    private var githubSignInButton: some View {
        Button(action: signInWithGitHub) {
            HStack(spacing: 10) {
                if isSigningIn {
                    ProgressView().tint(Theme.Colors.textPrimary)
                } else {
                    Image("GitHubMark")
                        .resizable()
                        .scaledToFit()
                        .frame(width: 18, height: 18)
                    Text("Sign in with GitHub")
                        .font(.system(size: 15, weight: .medium))
                }
            }
            .frame(maxWidth: .infinity)
            .frame(height: 48)
            .background(Theme.Colors.surfaceRaised)
            .foregroundStyle(Theme.Colors.textPrimary)
            .clipShape(Capsule())
        }
        .disabled(isSigningIn)
    }

    private func connectedBanner(_ connection: GitHubConnection) -> some View {
        HStack(spacing: 10) {
            Image(systemName: "checkmark")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(Theme.Colors.approve)
            VStack(alignment: .leading, spacing: 2) {
                Text(connection.username)
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(Theme.Colors.textPrimary)
                Text(connection.repository)
                    .font(.system(size: 12, design: .monospaced))
                    .foregroundStyle(Theme.Colors.textTertiary)
            }
            Spacer()
        }
        .padding(Theme.Spacing.md)
        .background(Theme.Colors.surfaceRaised)
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.card))
        .overlay {
            RoundedRectangle(cornerRadius: Theme.Radius.card)
                .strokeBorder(Theme.Colors.border, lineWidth: 1)
        }
    }

    private var repositoryPicker: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            HStack {
                Text("Repository")
                    .font(Theme.TypeScale.micro)
                    .foregroundStyle(Theme.Colors.textTertiary)
                    .textCase(.uppercase)
                    .tracking(0.8)
                Spacer()
                Button(action: refreshRepositories) {
                    Group {
                        if isRefreshingRepos {
                            ProgressView()
                                .controlSize(.small)
                                .tint(Theme.Colors.textSecondary)
                        } else {
                            Image(systemName: "arrow.clockwise")
                                .font(.system(size: 13, weight: .medium))
                                .foregroundStyle(Theme.Colors.textSecondary)
                        }
                    }
                    .frame(width: 28, height: 28)
                }
                .disabled(isRefreshingRepos)
                .accessibilityLabel("Refresh repositories")
            }

            if appState.githubService.repositories.isEmpty {
                Text(isRefreshingRepos ? String(localized: "Loading repositories…") : String(localized: "No repositories found"))
                    .font(Theme.TypeScale.caption)
                    .foregroundStyle(Theme.Colors.textSecondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(Theme.Spacing.md)
                    .background(Theme.Colors.surfaceRaised)
                    .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.input))
                    .overlay {
                        RoundedRectangle(cornerRadius: Theme.Radius.input)
                            .strokeBorder(Theme.Colors.border, lineWidth: 1)
                    }
            } else {
                Picker("Repository", selection: $selectedRepository) {
                    Text("Select").tag(Optional<GitHubRepository>.none)
                    ForEach(appState.githubService.repositories) { repo in
                        Text(repo.fullName).tag(Optional(repo))
                    }
                }
                .pickerStyle(.menu)
                .tint(Theme.Colors.textPrimary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(Theme.Spacing.md)
                .background(Theme.Colors.surfaceRaised)
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.input))
                .overlay {
                    RoundedRectangle(cornerRadius: Theme.Radius.input)
                        .strokeBorder(Theme.Colors.border, lineWidth: 1)
                }
            }
        }
    }

    private var canConnectGitHub: Bool {
        appState.githubService.isConnected || selectedRepository != nil
    }

    private func signInWithGitHub() {
        errorMessage = nil
        isSigningIn = true

        Task {
            do {
                guard let backendBaseURL = appState.backendBaseURL else {
                    throw URLError(.badURL)
                }
                try await appState.githubService.signInWithOAuth(backendBaseURL: backendBaseURL)
                selectedRepository = appState.githubService.repositories.first
            } catch {
                errorMessage = error.localizedDescription
            }
            isSigningIn = false
        }
    }

    private func refreshRepositories() {
        errorMessage = nil
        isRefreshingRepos = true

        Task {
            do {
                let repos = try await appState.githubService.refreshRepositories()
                if selectedRepository == nil {
                    selectedRepository = repos.first
                } else if let current = selectedRepository,
                          !repos.contains(where: { $0.id == current.id }) {
                    selectedRepository = repos.first
                }
            } catch {
                errorMessage = error.localizedDescription
            }
            isRefreshingRepos = false
        }
    }

    private func connectGitHubAndEnter() {
        errorMessage = nil
        isConnecting = true

        Task {
            do {
                guard let repository = selectedRepository?.fullName
                    ?? appState.githubService.connection?.repository else {
                    throw GitHubServiceError.missingCredentials
                }
                let connection = try await appState.githubService.connect(repository: repository)
                Haptics.success()
                await appState.activateGitHubSession(connection: connection)
            } catch {
                errorMessage = error.localizedDescription
            }
            isConnecting = false
        }
    }

    // MARK: - Shared

    private func stepTitle(_ title: LocalizedStringKey, subtitle: LocalizedStringKey) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            Text(title)
                .font(.system(size: 28, weight: .medium))
                .foregroundStyle(Theme.Colors.textPrimary)
            Text(subtitle)
                .font(Theme.TypeScale.caption)
                .foregroundStyle(Theme.Colors.textSecondary)
                .lineSpacing(4)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.top, Theme.Spacing.xl)
    }
}

#Preview {
    OnboardingView()
        .environmentObject(AppState())
}
