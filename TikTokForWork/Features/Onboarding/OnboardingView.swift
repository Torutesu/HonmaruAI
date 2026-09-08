import SwiftUI

/// One clear entry screen, followed by optional GitHub workspace setup.
/// The sample workspace is interactive and separate from live team data.
struct OnboardingView: View {
    @EnvironmentObject private var appState: AppState
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var showConnection = false
    @State private var selectedRepository: GitHubRepository?
    @State private var isSigningIn = false
    @State private var isConnecting = false
    @State private var isRefreshingRepos = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Group {
                if showConnection { githubStep } else { welcomeStep }
            }
            .background(Theme.Colors.surface.ignoresSafeArea())
            .toolbar {
                if showConnection {
                    ToolbarItem(placement: .topBarLeading) {
                        Button { showConnection = false } label: {
                            Label("Back", systemImage: "chevron.left")
                        }
                        .disabled(isSigningIn || isConnecting)
                    }
                }
            }
            .animation(reduceMotion ? nil : .easeOut(duration: 0.18), value: showConnection)
        }
        .tint(Theme.Colors.interactive)
    }

    private var welcomeStep: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                HStack(spacing: 10) {
                    AppLogo(size: 34)
                    Text("Honmaru AI").font(.headline)
                    Spacer()
                }
                .padding(.top, 12)

                VStack(alignment: .leading, spacing: 12) {
                    Text("Less chasing.\nClearer decisions.")
                        .font(.largeTitle.weight(.bold))
                        .tracking(-0.8)
                        .fixedSize(horizontal: false, vertical: true)
                    Text("Review what needs you, send a clear request, and keep every decision in one place.")
                        .font(.body)
                        .foregroundStyle(Theme.Colors.textSecondary)
                        .lineSpacing(3)
                }

                VStack(spacing: 0) {
                    HStack {
                        Label("Inbox", systemImage: "tray")
                            .font(.subheadline.weight(.semibold))
                        Spacer()
                        Text("Sample workspace")
                            .font(.caption.weight(.medium))
                            .foregroundStyle(Theme.Colors.accent)
                    }
                    .padding(18)
                    Divider().overlay(Theme.Colors.border)
                    sampleRow("Approve the onboarding release", subtitle: "Ken · Approval", symbol: "checkmark.seal", tint: Theme.Colors.approve)
                    Divider().padding(.leading, 58)
                    sampleRow("Review the customer handoff checklist", subtitle: "Aya · Task", symbol: "checklist", tint: Theme.Colors.interactive)
                    Divider().padding(.leading, 58)
                    sampleRow("Confirm the homepage direction", subtitle: "Mika · Question", symbol: "bubble.left", tint: Theme.Colors.accent)
                }
                .background(Theme.Colors.background, in: RoundedRectangle(cornerRadius: 20))
                .overlay(RoundedRectangle(cornerRadius: 20).strokeBorder(Theme.Colors.border, lineWidth: 1))
                .accessibilityElement(children: .contain)

                HStack(alignment: .top, spacing: 10) {
                    Image(systemName: "hand.tap").foregroundStyle(Theme.Colors.accent)
                    Text("Try approving, replying, and creating a request. No account needed.")
                        .font(.subheadline)
                        .foregroundStyle(Theme.Colors.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(.horizontal, 24)
            .padding(.bottom, 24)
        }
        .scrollIndicators(.hidden)
        .safeAreaInset(edge: .bottom, spacing: 0) {
            VStack(spacing: 12) {
                PrimaryButton(title: String(localized: "Try the demo")) {
                    appState.activateGuestSession()
                }
                Button {
                    showConnection = true
                } label: {
                    HStack(spacing: 8) {
                        Image("GitHubMark").resizable().scaledToFit().frame(width: 18, height: 18)
                        Text("Connect GitHub").font(.body.weight(.medium))
                    }
                    .frame(maxWidth: .infinity, minHeight: 48)
                    .foregroundStyle(Theme.Colors.textPrimary)
                    .background(Theme.Colors.background, in: RoundedRectangle(cornerRadius: 14))
                    .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(Theme.Colors.border, lineWidth: 1))
                }
                .buttonStyle(PressFeedbackStyle())
            }
            .padding(.horizontal, 24)
            .padding(.top, 16)
            .padding(.bottom, 16)
            .background(Theme.Colors.surface)
        }
    }

    private func sampleRow(_ title: LocalizedStringKey, subtitle: LocalizedStringKey, symbol: String, tint: Color) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: symbol)
                .font(.system(size: 15, weight: .medium))
                .foregroundStyle(tint)
                .frame(width: 30, height: 32)
                .background(tint.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
            VStack(alignment: .leading, spacing: 5) {
                Text(title).font(.subheadline.weight(.semibold))
                    .foregroundStyle(Theme.Colors.textPrimary)
                    .fixedSize(horizontal: false, vertical: true)
                Text(subtitle).font(.caption).foregroundStyle(Theme.Colors.textSecondary)
            }
            Spacer(minLength: 0)
        }
        .padding(18)
    }

    private var githubStep: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                Label("Your workspace", systemImage: "person.2")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Theme.Colors.accent)
                VStack(alignment: .leading, spacing: 12) {
                    Text("Bring your team into focus.")
                        .font(.largeTitle.weight(.bold))
                        .tracking(-0.6)
                    Text("Connect a GitHub repository to see its collaborators and send real requests to your team.")
                        .font(.body)
                        .foregroundStyle(Theme.Colors.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                VStack(alignment: .leading, spacing: 20) {
                    Label("1. Sign in securely with GitHub", systemImage: "person.crop.circle.badge.checkmark")
                    Label("2. Choose your team's repository", systemImage: "folder")
                    Label("3. Review requests together", systemImage: "tray")
                }
                .font(.subheadline)
                .foregroundStyle(Theme.Colors.textSecondary)
                .padding(20)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Theme.Colors.background, in: RoundedRectangle(cornerRadius: 16))
                .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(Theme.Colors.border, lineWidth: 1))

                if appState.githubService.hasToken { repositoryPicker } else { githubSignInButton }
                if appState.githubService.isConnected, let connection = appState.githubService.connection { connectedBanner(connection) }
                if let errorMessage {
                    Label(errorMessage, systemImage: "exclamationmark.circle")
                        .font(.subheadline).foregroundStyle(Theme.Colors.reject)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(24)
        }
        .safeAreaInset(edge: .bottom) {
            VStack(spacing: 12) {
                PrimaryButton(title: String(localized: "Open workspace"), enabled: canConnectGitHub && !isConnecting && !isSigningIn) {
                    connectGitHubAndEnter()
                }
                if isConnecting { ProgressView("Connecting…").font(.footnote) }
                Button("Try the demo first") { appState.activateGuestSession() }
                    .font(.subheadline).foregroundStyle(Theme.Colors.textSecondary)
                    .frame(minHeight: 36)
                    .disabled(isConnecting || isSigningIn)
            }
            .padding(24)
            .background(Theme.Colors.surface)
        }
        .onAppear {
            if selectedRepository == nil, let repository = appState.githubService.connection?.repository {
                selectedRepository = appState.githubService.repositories.first { $0.fullName == repository }
            }
            if appState.githubService.hasToken, appState.githubService.repositories.isEmpty { refreshRepositories() }
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
                Text(isRefreshingRepos ? String(localized: "Loading repositories…") : String(localized: "No repositories found"))
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
