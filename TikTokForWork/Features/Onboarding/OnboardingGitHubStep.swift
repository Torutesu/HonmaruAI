import SwiftUI

struct OnboardingGitHubStep: View {
    @EnvironmentObject private var appState: AppState
    @State private var selectedRepository: GitHubRepository?
    @State private var isConnecting = false
    @State private var isSigningIn = false
    @State private var isRefreshingRepos = false
    @State private var errorMessage: String?
    let onContinue: () -> Void

    var body: some View {
        OnboardingScaffold(
            kicker: "Connect tools · 1 of 5",
            title: "Connect GitHub",
            subtitle: "Approved decisions become Issues, so engineers see them without opening the app.",
            buttonTitle: appState.githubService.isConnected ? "Continue" : "Link repository",
            buttonEnabled: canContinue && !isConnecting && !isSigningIn,
            action: connectAndAdvance
        ) {
            VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                if appState.githubService.hasToken {
                    repositoryPicker
                } else {
                    signInButton
                }

                if appState.githubService.isConnected, let connection = appState.githubService.connection {
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

                if let errorMessage {
                    Text(errorMessage)
                        .font(Theme.TypeScale.label)
                        .foregroundStyle(Theme.Colors.reject)
                }

                Text("Your GitHub secret never leaves the localhost relay.")
                    .font(Theme.TypeScale.micro)
                    .foregroundStyle(Theme.Colors.textTertiary)
            }
        }
        .onAppear {
            if selectedRepository == nil,
               let repository = appState.githubService.connection?.repository {
                selectedRepository = appState.githubService.repositories.first { $0.fullName == repository }
            }
        }
    }

    private var signInButton: some View {
        Button(action: signIn) {
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

    private var canContinue: Bool {
        appState.githubService.isConnected || selectedRepository != nil
    }

    private func signIn() {
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

    private func connectAndAdvance() {
        if appState.githubService.isConnected, selectedRepository == nil {
            onContinue()
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
                onContinue()
            } catch {
                errorMessage = error.localizedDescription
            }
            isConnecting = false
        }
    }
}
