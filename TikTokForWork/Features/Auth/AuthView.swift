import SwiftUI

struct AuthView: View {
    @EnvironmentObject private var appState: AppState
    @State private var selectedRepository: GitHubRepository?
    @State private var isConnecting = false
    @State private var isSigningInWithGitHub = false
    @State private var isRefreshingRepos = false
    @State private var errorMessage: String?

    var body: some View {
        VStack(spacing: 0) {
            Spacer()

            VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                AppLogo(size: 56)
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
        .onAppear {
            if selectedRepository == nil,
               let repository = appState.githubService.connection?.repository {
                selectedRepository = appState.githubService.repositories.first { $0.fullName == repository }
            }
        }
    }

    private var githubSignInButton: some View {
        Button(action: signInWithGitHub) {
            HStack(spacing: 10) {
                if isSigningInWithGitHub {
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
        appState.githubService.isConnected || selectedRepository != nil
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

    private func signInWithGitHub() {
        errorMessage = nil
        isSigningInWithGitHub = true

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
            isSigningInWithGitHub = false
        }
    }

    private func connectAndEnter() {
        errorMessage = nil
        isConnecting = true

        Task {
            do {
                if let repository = selectedRepository?.fullName ?? appState.githubService.connection?.repository {
                    _ = try await appState.githubService.connect(repository: repository)
                } else {
                    throw GitHubServiceError.missingCredentials
                }

                await appState.activateSession()
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
