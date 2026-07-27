import SwiftUI

struct AuthView: View {
    @EnvironmentObject private var appState: AppState
    @State private var selectedUser: DemoUser = .alice
    @State private var selectedRepository: GitHubRepository?
    @State private var relayURL = "ws://127.0.0.1:8080"
    @State private var openAIKey = ""
    @State private var isConnecting = false
    @State private var isSigningInWithGitHub = false
    @State private var errorMessage: String?

    var body: some View {
        VStack(spacing: 0) {
            Spacer()

            Text("TikTok for Work")
                .font(.system(size: 28, weight: .medium))
                .foregroundStyle(Theme.Colors.textPrimary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, Theme.Spacing.screen)
                .padding(.bottom, Theme.Spacing.xl)

            VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
                fieldSection(title: "User") {
                    Picker("User", selection: $selectedUser) {
                        ForEach(DemoUser.allCases) { user in
                            Text("\(user.displayName) · \(user.subtitle)").tag(user)
                        }
                    }
                    .pickerStyle(.segmented)
                }

                if appState.githubService.isConnected, let connection = appState.githubService.connection {
                    statusRow("\(connection.username) · \(connection.repository)")
                } else if appState.githubService.hasToken {
                    repositoryPicker
                } else {
                    githubSignInButton
                }

                fieldSection(title: "Relay server") {
                    TextField("ws://127.0.0.1:8080", text: $relayURL)
                        .font(.system(size: 15, design: .monospaced))
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .fieldStyle()
                }

                fieldSection(title: "OpenAI key") {
                    SecureField("sk-... (optional)", text: $openAIKey)
                        .font(.system(size: 15, design: .monospaced))
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .fieldStyle()
                }

                if let errorMessage {
                    Text(errorMessage)
                        .font(.system(size: 12))
                        .foregroundStyle(Theme.Colors.reject)
                }
            }
            .padding(.horizontal, Theme.Spacing.screen)

            Spacer()

            Button(action: connectAndEnter) {
                Group {
                    if isConnecting {
                        ProgressView()
                            .tint(Theme.Colors.textPrimary)
                    } else {
                        Text("Continue")
                            .font(.system(size: 15, weight: .medium))
                    }
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 14)
                .background(canContinue ? Theme.Colors.accent : Theme.Colors.surfaceRaised)
                .foregroundStyle(Theme.Colors.textPrimary)
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
            }
            .disabled(!canContinue || isConnecting || isSigningInWithGitHub)
            .padding(.horizontal, Theme.Spacing.screen)
            .padding(.bottom, Theme.Spacing.xl)
        }
        .appBackground()
    }

    private var githubSignInButton: some View {
        Button(action: signInWithGitHub) {
            HStack {
                if isSigningInWithGitHub {
                    ProgressView()
                        .tint(Theme.Colors.textPrimary)
                } else {
                    Image(systemName: "chevron.left.forwardslash.chevron.right")
                    Text("Sign in with GitHub")
                        .font(.system(size: 15, weight: .medium))
                }
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 14)
            .background(Theme.Colors.surfaceRaised)
            .foregroundStyle(Theme.Colors.textPrimary)
            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
        }
        .disabled(isSigningInWithGitHub)
    }

    private var repositoryPicker: some View {
        fieldSection(title: "Repository") {
            if appState.githubService.repositories.isEmpty {
                Text("No repositories found")
                    .font(.system(size: 14))
                    .foregroundStyle(Theme.Colors.textSecondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .fieldStyle()
            } else {
                Picker("Repository", selection: $selectedRepository) {
                    Text("Select repository").tag(Optional<GitHubRepository>.none)
                    ForEach(appState.githubService.repositories) { repo in
                        Text(repo.fullName).tag(Optional(repo))
                    }
                }
                .pickerStyle(.menu)
                .tint(Theme.Colors.textPrimary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(Theme.Spacing.md)
                .background(Theme.Colors.surfaceRaised)
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
            }
        }
    }

    private var canContinue: Bool {
        let hasGitHub = appState.githubService.isConnected || selectedRepository != nil
        let hasRelay = !relayURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        return hasGitHub && hasRelay
    }

    private func statusRow(_ text: String) -> some View {
        HStack(spacing: Theme.Spacing.sm) {
            Image(systemName: "checkmark.circle.fill")
                .foregroundStyle(Theme.Colors.approve)
                .font(.system(size: 13))
            Text(text)
                .font(.system(size: 12, design: .monospaced))
                .foregroundStyle(Theme.Colors.textSecondary)
                .lineLimit(1)
        }
    }

    private func fieldSection<Content: View>(title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            Text(title)
                .font(.system(size: 12))
                .foregroundStyle(Theme.Colors.textTertiary)
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

                if !openAIKey.isEmpty {
                    appState.aiService.configure(apiKey: openAIKey)
                }

                appState.relayURL = relayURL.trimmingCharacters(in: .whitespacesAndNewlines)

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
            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
            .foregroundStyle(Theme.Colors.textPrimary)
    }
}

#Preview {
    AuthView()
        .environmentObject(AppState())
}
