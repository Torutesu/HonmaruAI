import SwiftUI

struct AuthView: View {
    @EnvironmentObject private var appState: AppState
    @State private var selectedRepository: GitHubRepository?
    @State private var isConnecting = false
    @State private var isSigningInWithGitHub = false
    @State private var isRefreshingRepos = false
    @State private var showRelaySettings = false
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
            .padding(.bottom, Theme.Spacing.md)

            Button { showRelaySettings = true } label: {
                HStack(spacing: 6) {
                    Image(systemName: "antenna.radiowaves.left.and.right")
                        .font(.system(size: 11))
                    Text(appState.relayURL)
                        .font(.system(size: 11, design: .monospaced))
                        .lineLimit(1)
                }
                .foregroundStyle(Theme.Colors.textTertiary)
            }
            .padding(.bottom, Theme.Spacing.xl)
        }
        .appBackground()
        .sheet(isPresented: $showRelaySettings) {
            RelaySettingsSheet()
                .environmentObject(appState)
                .presentationDetents([.medium, .large])
                .presentationBackground(Theme.Colors.surface)
                .presentationDragIndicator(.visible)
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
                try await appState.githubService.signInWithOAuth(
                    backendBaseURL: backendBaseURL,
                    relayToken: appState.relayToken
                )
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

struct RelaySettingsSheet: View {
    @EnvironmentObject private var appState: AppState
    @Environment(\.dismiss) private var dismiss
    @State private var url = ""
    @State private var token = ""
    @State private var isTesting = false
    @State private var statusMessage: String?
    @State private var statusOK = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
                    VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                        Text("Relay URL")
                            .font(Theme.TypeScale.micro)
                            .foregroundStyle(Theme.Colors.textTertiary)
                            .textCase(.uppercase)
                            .tracking(0.8)

                        TextField(AppConfig.defaultRelayURL, text: $url)
                            .font(.system(size: 14, design: .monospaced))
                            .keyboardType(.URL)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .padding(Theme.Spacing.md)
                            .background(Theme.Colors.surfaceRaised)
                            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))

                        Text("ws:// for local development, wss:// for a deployed relay")
                            .font(Theme.TypeScale.caption)
                            .foregroundStyle(Theme.Colors.textTertiary)
                    }

                    VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                        Text("Relay token")
                            .font(Theme.TypeScale.micro)
                            .foregroundStyle(Theme.Colors.textTertiary)
                            .textCase(.uppercase)
                            .tracking(0.8)

                        SecureField("Optional", text: $token)
                            .font(.system(size: 14, design: .monospaced))
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .padding(Theme.Spacing.md)
                            .background(Theme.Colors.surfaceRaised)
                            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))

                        Text("Required when the relay is started with RELAY_TOKEN")
                            .font(Theme.TypeScale.caption)
                            .foregroundStyle(Theme.Colors.textTertiary)
                    }

                    if let statusMessage {
                        Text(statusMessage)
                            .font(Theme.TypeScale.caption)
                            .foregroundStyle(statusOK ? Theme.Colors.approve : Theme.Colors.reject)
                    }

                    PrimaryButton(title: "Save") {
                        Task {
                            await appState.updateRelaySettings(url: url, token: token)
                            dismiss()
                        }
                    }

                    Button(action: testConnection) {
                        HStack(spacing: 8) {
                            if isTesting {
                                ProgressView()
                                    .controlSize(.small)
                                    .tint(Theme.Colors.textSecondary)
                            }
                            Text("Test connection")
                                .font(.system(size: 14))
                        }
                        .frame(maxWidth: .infinity)
                        .frame(height: 40)
                        .foregroundStyle(Theme.Colors.textSecondary)
                    }
                    .disabled(isTesting)
                }
                .padding(Theme.Spacing.screen)
            }
            .background(Theme.Colors.background)
            .navigationTitle("Relay server")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .foregroundStyle(Theme.Colors.textSecondary)
                }
            }
        }
        .onAppear {
            url = appState.relayURL
            token = appState.relayToken ?? ""
        }
    }

    private func testConnection() {
        isTesting = true
        statusMessage = nil

        Task {
            defer { isTesting = false }

            let trimmedURL = url.trimmingCharacters(in: .whitespacesAndNewlines)
            guard let base = BackendURL.httpBase(from: trimmedURL.isEmpty ? AppConfig.defaultRelayURL : trimmedURL),
                  let healthURL = URL(string: "/health", relativeTo: base) else {
                statusOK = false
                statusMessage = "Invalid relay URL."
                return
            }

            do {
                let (data, response) = try await URLSession.shared.data(from: healthURL)
                guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
                    statusOK = false
                    statusMessage = "Relay responded with an error."
                    return
                }

                let health = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
                let aiRouting = health?["aiRouting"] as? Bool ?? false
                let authRequired = health?["authRequired"] as? Bool ?? false
                let trimmedToken = token.trimmingCharacters(in: .whitespacesAndNewlines)

                if authRequired, trimmedToken.isEmpty {
                    statusOK = false
                    statusMessage = "Relay reachable — it requires a token, add it above."
                } else {
                    statusOK = true
                    statusMessage = aiRouting
                        ? "Relay reachable · AI routing on"
                        : "Relay reachable · AI in local fallback mode"
                }
            } catch {
                statusOK = false
                statusMessage = error.localizedDescription
            }
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
