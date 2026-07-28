import SwiftUI

struct AuthView: View {
    @EnvironmentObject private var appState: AppState
    @State private var selectedUser: DemoUser = .alice
    @State private var selectedRepository: GitHubRepository?
    @State private var relayURL = "ws://127.0.0.1:8080"
    @State private var isConnecting = false
    @State private var isSigningInWithGitHub = false
    @State private var errorMessage: String?

    var body: some View {
        VStack(spacing: 0) {
            Spacer()

            VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                Text("TikTok for Work")
                    .font(.system(size: 32, weight: .medium))
                    .foregroundStyle(Theme.Colors.textPrimary)
                Text("Decisions, not messages")
                    .font(Theme.TypeScale.caption)
                    .foregroundStyle(Theme.Colors.textTertiary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, Theme.Spacing.screen)
            .padding(.bottom, Theme.Spacing.xxl)

            VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
                if appState.githubService.isConnected, let connection = appState.githubService.connection {
                    connectedBanner(connection)
                } else if appState.githubService.hasToken {
                    repositoryPicker
                } else {
                    githubSignInButton
                }

                fieldSection(title: "Workspace") {
                    Picker("User", selection: $selectedUser) {
                        ForEach(DemoUser.allCases) { user in
                            Text("\(user.displayName) · \(user.subtitle)").tag(user)
                        }
                    }
                    .pickerStyle(.segmented)
                }

                fieldSection(title: "Relay") {
                    VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                        TextField("ws://127.0.0.1:8080", text: $relayURL)
                            .font(.system(size: 14, design: .monospaced))
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .fieldStyle()

                        if let model = appState.aiService.modelName {
                            Text("AI routing: \(model)")
                                .font(Theme.TypeScale.micro)
                                .foregroundStyle(Theme.Colors.approve)
                        } else {
                            Text("AI routing uses keyword fallback until OPENROUTER_API_KEY is set on relay")
                                .font(Theme.TypeScale.micro)
                                .foregroundStyle(Theme.Colors.textTertiary)
                        }
                    }
                }

                if let errorMessage {
                    Text(errorMessage)
                        .font(Theme.TypeScale.label)
                        .foregroundStyle(Theme.Colors.reject)
                }
            }
            .padding(.horizontal, Theme.Spacing.screen)

            Spacer()

            PrimaryButton(title: "Continue", enabled: canContinue && !isConnecting && !isSigningInWithGitHub) {
                connectAndEnter()
            }
            .overlay {
                if isConnecting {
                    ProgressView().tint(Theme.Colors.background)
                }
            }
            .padding(.horizontal, Theme.Spacing.screen)
            .padding(.bottom, Theme.Spacing.xl)
        }
        .appBackground()
        .task(id: relayURL) {
            guard let backend = BackendURL.httpBase(from: relayURL) else { return }
            await appState.aiService.configure(backendBaseURL: backend)
        }
    }

    private var githubSignInButton: some View {
        Button(action: signInWithGitHub) {
            HStack(spacing: 10) {
                if isSigningInWithGitHub {
                    ProgressView().tint(Theme.Colors.textPrimary)
                } else {
                    Image(systemName: "chevron.left.forwardslash.chevron.right")
                        .font(.system(size: 14))
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
        .disabled(isSigningInWithGitHub)
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
        fieldSection(title: "Repository") {
            if appState.githubService.repositories.isEmpty {
                Text("No repositories found")
                    .font(Theme.TypeScale.caption)
                    .foregroundStyle(Theme.Colors.textSecondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .fieldStyle()
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

    private var canContinue: Bool {
        let hasGitHub = appState.githubService.isConnected || selectedRepository != nil
        let hasRelay = !relayURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        return hasGitHub && hasRelay
    }

    private func fieldSection<Content: View>(title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            Text(title)
                .font(Theme.TypeScale.micro)
                .foregroundStyle(Theme.Colors.textTertiary)
                .textCase(.uppercase)
                .tracking(0.8)
            content()
        }
    }

    private func signInWithGitHub() {
        errorMessage = nil
        isSigningInWithGitHub = true

        Task {
            do {
                guard let backendBaseURL = BackendURL.httpBase(from: relayURL) else {
                    throw URLError(.badURL)
                }
                try await appState.githubService.signInWithOAuth(backendBaseURL: backendBaseURL)
                selectedRepository = appState.githubService.repositories.first
            } catch {
                errorMessage = error.localizedDescription
            }
            isSigningInWithGitHub = false
        }
    }

    private func connectAndEnter() {
        errorMessage = nil
        isConnecting = true

        Task {
            do {
                if !appState.githubService.isConnected {
                    guard let repository = selectedRepository?.fullName else {
                        throw GitHubServiceError.missingCredentials
                    }
                    _ = try await appState.githubService.connect(repository: repository)
                }

                appState.relayURL = relayURL.trimmingCharacters(in: .whitespacesAndNewlines)

                if let backend = BackendURL.httpBase(from: appState.relayURL) {
                    await appState.aiService.configure(backendBaseURL: backend)
                }

                do {
                    try await appState.webSocketService.connect(
                        urlString: appState.relayURL,
                        userId: selectedUser.user.id
                    )
                } catch {
                    appState.cardService.bootstrap(for: selectedUser.user)
                }

                appState.currentUser = selectedUser.user
                appState.isAuthenticated = true
            } catch {
                errorMessage = error.localizedDescription
            }
            isConnecting = false
        }
    }
}

private extension View {
    func fieldStyle() -> some View {
        padding(Theme.Spacing.md)
            .background(Theme.Colors.surfaceRaised)
            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))
            .foregroundStyle(Theme.Colors.textPrimary)
    }
}

#Preview {
    AuthView()
        .environmentObject(AppState())
}
