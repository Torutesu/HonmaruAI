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
        case persona
    }

    @State private var step: Step = .welcome

    // GitHub step
    @State private var selectedRepository: GitHubRepository?
    @State private var isSigningIn = false
    @State private var isConnecting = false
    @State private var isRefreshingRepos = false
    @State private var errorMessage: String?

    // Persona step
    @State private var enteringUserID: String?

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
                case .persona: personaStep
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

            AppLogo(size: 64)
                .padding(.bottom, Theme.Spacing.lg)

            Text("Decisions,\nnot messages")
                .font(.system(size: 36, weight: .medium))
                .foregroundStyle(Theme.Colors.textPrimary)
                .lineSpacing(2)
                .padding(.bottom, Theme.Spacing.md)

            Text("A work feed where nothing needs reading twice. Your AI turns your team's asks, approvals, and tasks into cards you clear in seconds.")
                .font(Theme.TypeScale.body)
                .foregroundStyle(Theme.Colors.textSecondary)
                .lineSpacing(5)
                .fixedSize(horizontal: false, vertical: true)

            Spacer()
            Spacer()

            PrimaryButton(title: "Get started") {
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

            PrimaryButton(title: "Continue") {
                Haptics.light()
                advance()
            }
            .padding(.bottom, Theme.Spacing.xl)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func routingRow(icon: String, title: String, detail: String) -> some View {
        HStack(alignment: .top, spacing: Theme.Spacing.md) {
            Image(systemName: icon)
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(icon == "sparkle" ? Theme.Colors.accent : Theme.Colors.textSecondary)
                .frame(width: 20, height: 20)

            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(Theme.Colors.textPrimary)
                Text(detail)
                    .font(Theme.TypeScale.caption)
                    .foregroundStyle(Theme.Colors.textTertiary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
        .padding(Theme.Spacing.md)
        .background(Theme.Colors.surfaceRaised)
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))
    }

    private var routingArrow: some View {
        Image(systemName: "arrow.down")
            .font(.system(size: 11, weight: .medium))
            .foregroundStyle(Theme.Colors.textTertiary)
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
                subtitle: "Every approval becomes a GitHub Issue your team can track — decisions never get lost in chat."
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
                    title: appState.githubService.isConnected ? "Continue" : "Connect and continue",
                    enabled: canConnectGitHub && !isConnecting && !isSigningIn
                ) {
                    connectGitHubAndAdvance()
                }
                .overlay {
                    if isConnecting {
                        ProgressView().tint(Theme.Colors.background)
                    }
                }

                Button {
                    Haptics.light()
                    advance()
                } label: {
                    Text("Skip for now — connect later from the feed")
                        .font(Theme.TypeScale.label)
                        .foregroundStyle(Theme.Colors.textTertiary)
                        .frame(height: 32)
                }
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
            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))
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
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))
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
                Text(isRefreshingRepos ? "Loading repositories…" : "No repositories found")
                    .font(Theme.TypeScale.caption)
                    .foregroundStyle(Theme.Colors.textSecondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(Theme.Spacing.md)
                    .background(Theme.Colors.surfaceRaised)
                    .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))
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
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))
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

    private func connectGitHubAndAdvance() {
        if appState.githubService.isConnected,
           selectedRepository?.fullName == appState.githubService.connection?.repository {
            advance()
            return
        }

        errorMessage = nil
        isConnecting = true

        Task {
            do {
                if let repository = selectedRepository?.fullName ?? appState.githubService.connection?.repository {
                    _ = try await appState.githubService.connect(repository: repository)
                } else {
                    throw GitHubServiceError.missingCredentials
                }
                Haptics.success()
                advance()
            } catch {
                errorMessage = error.localizedDescription
            }
            isConnecting = false
        }
    }

    // MARK: - 5. Persona

    private var personaStep: some View {
        VStack(alignment: .leading, spacing: 0) {
            stepTitle(
                "Who are you?",
                subtitle: "Each person has their own AI — and sees only the decisions that are theirs to make. You can switch anytime from the feed."
            )

            VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                ForEach(DemoUser.allCases) { demoUser in
                    personaRow(demoUser)
                }
            }
            .padding(.top, Theme.Spacing.lg)

            Spacer()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func personaRow(_ demoUser: DemoUser) -> some View {
        Button {
            enter(demoUser)
        } label: {
            HStack(spacing: Theme.Spacing.md) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(demoUser.displayName)
                        .font(.system(size: 15, weight: .medium))
                        .foregroundStyle(Theme.Colors.textPrimary)
                    Text(demoUser.user.role)
                        .font(.system(size: 12))
                        .foregroundStyle(Theme.Colors.textTertiary)
                }

                Spacer()

                if enteringUserID == demoUser.id {
                    ProgressView()
                        .controlSize(.small)
                        .tint(Theme.Colors.textSecondary)
                } else if demoUser == .toru {
                    Text("Start here")
                        .font(Theme.TypeScale.micro)
                        .foregroundStyle(Theme.Colors.accent)
                } else {
                    Image(systemName: "arrow.right")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(Theme.Colors.textTertiary)
                }
            }
            .padding(Theme.Spacing.md)
            .background(Theme.Colors.surfaceRaised)
            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))
        }
        .buttonStyle(.plain)
        .disabled(enteringUserID != nil)
    }

    private func enter(_ demoUser: DemoUser) {
        guard enteringUserID == nil else { return }
        enteringUserID = demoUser.id
        Haptics.light()

        Task {
            await appState.activateSession(as: demoUser.user)
        }
    }

    // MARK: - Shared

    private func stepTitle(_ title: String, subtitle: String) -> some View {
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
