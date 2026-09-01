import SwiftUI

/// Contextual GitHub connection. Presented from the feed — after the first
/// approval, from the local-mode chip, or from the account menu — instead of
/// blocking the app behind an auth wall.
struct ConnectGitHubSheet: View {
    enum Context {
        case afterFirstApproval
        case settings

        var title: String {
            switch self {
            case .afterFirstApproval: String(localized: "Decision recorded")
            case .settings: String(localized: "Sync to GitHub")
            }
        }

        var subtitle: String {
            switch self {
            case .afterFirstApproval:
                String(localized: "Connect GitHub and every approval becomes an Issue your team can track.")
            case .settings:
                String(localized: "Approvals, delegations, and revisions sync as GitHub Issues.")
            }
        }
    }

    let context: Context

    @EnvironmentObject private var appState: AppState
    @Environment(\.dismiss) private var dismiss

    @State private var selectedRepository: GitHubRepository?
    @State private var isConnecting = false
    @State private var isSigningInWithGitHub = false
    @State private var isRefreshingRepos = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
                VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                    if context == .afterFirstApproval {
                        Image(systemName: "checkmark.circle")
                            .font(.system(size: 24, weight: .regular))
                            .foregroundStyle(Theme.Colors.approve)
                            .padding(.bottom, Theme.Spacing.xs)
                    }

                    Text(context.title)
                        .font(.system(size: 24, weight: .medium))
                        .foregroundStyle(Theme.Colors.textPrimary)

                    Text(context.subtitle)
                        .font(Theme.TypeScale.caption)
                        .foregroundStyle(Theme.Colors.textSecondary)
                        .lineSpacing(4)
                        .fixedSize(horizontal: false, vertical: true)
                }

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

                Spacer()

                PrimaryButton(
                    title: appState.githubService.isConnected ? String(localized: "Done") : String(localized: "Connect"),
                    enabled: canConnect && !isConnecting && !isSigningInWithGitHub
                ) {
                    connect()
                }
                .overlay {
                    if isConnecting {
                        ProgressView().tint(Theme.Colors.background)
                    }
                }
            }
            .padding(Theme.Spacing.screen)
            .background(Theme.Colors.surface)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Not now") { dismiss() }
                        .foregroundStyle(Theme.Colors.textSecondary)
                }
            }
        }
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
            .clipShape(Capsule())
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

    private var canConnect: Bool {
        appState.githubService.isConnected || selectedRepository != nil
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

    private func connect() {
        if appState.githubService.isConnected, selectedRepository?.fullName == appState.githubService.connection?.repository {
            dismiss()
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
                dismiss()
            } catch {
                errorMessage = error.localizedDescription
            }
            isConnecting = false
        }
    }
}

#Preview {
    ConnectGitHubSheet(context: .settings)
        .environmentObject(AppState())
}
