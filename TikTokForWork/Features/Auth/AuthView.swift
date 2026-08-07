import SwiftUI

struct AuthView: View {
    @EnvironmentObject private var appState: AppState

    @State private var name = ""
    @State private var orgName = ""
    @State private var jobTitle = ""
    @State private var inviteCode = ""
    @State private var serverURL = AppConfig.backendHTTP
    @State private var mode: Mode = .create
    @State private var isWorking = false
    @State private var errorMessage: String?

    private enum Mode: String, CaseIterable {
        case create = "New workspace"
        case join = "Join with code"
    }

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
                field(title: "Your name") {
                    TextField("Alice", text: $name)
                        .textInputAutocapitalization(.words)
                }

                field(title: "Job title") {
                    TextField("Product Manager", text: $jobTitle)
                        .textInputAutocapitalization(.words)
                }

                Picker("Mode", selection: $mode) {
                    ForEach(Mode.allCases, id: \.self) { mode in
                        Text(mode.rawValue).tag(mode)
                    }
                }
                .pickerStyle(.segmented)

                if mode == .create {
                    field(title: "Workspace name") {
                        TextField("Acme", text: $orgName)
                            .textInputAutocapitalization(.words)
                    }
                } else {
                    field(title: "Invite code") {
                        TextField("Paste code", text: $inviteCode)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                    }
                }

                field(title: "Server") {
                    TextField(AppConfig.defaultBackendHTTP, text: $serverURL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                }

                if let errorMessage {
                    Text(errorMessage)
                        .font(Theme.TypeScale.label)
                        .foregroundStyle(Theme.Colors.reject)
                }
            }
            .padding(.horizontal, Theme.Spacing.screen)

            Spacer()

            PrimaryButton(title: "Continue", enabled: canContinue && !isWorking) {
                continueTapped()
            }
            .overlay {
                if isWorking {
                    ProgressView().tint(Theme.Colors.background)
                }
            }
            .padding(.horizontal, Theme.Spacing.screen)
            .padding(.bottom, Theme.Spacing.xl)
        }
        .appBackground()
    }

    private func field<Content: View>(title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            Text(title)
                .font(Theme.TypeScale.micro)
                .foregroundStyle(Theme.Colors.textTertiary)
                .textCase(.uppercase)
                .tracking(0.8)
            content()
                .font(Theme.TypeScale.body)
                .foregroundStyle(Theme.Colors.textPrimary)
                .padding(Theme.Spacing.md)
                .background(Theme.Colors.surfaceRaised)
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))
        }
    }

    private var canContinue: Bool {
        let hasIdentity = !name.trimmingCharacters(in: .whitespaces).isEmpty
        switch mode {
        case .create:
            return hasIdentity && !orgName.trimmingCharacters(in: .whitespaces).isEmpty
        case .join:
            return hasIdentity && !inviteCode.trimmingCharacters(in: .whitespaces).isEmpty
        }
    }

    private func continueTapped() {
        let trimmedURL = serverURL.trimmingCharacters(in: .whitespaces)
        SessionStore.backendURL = trimmedURL.isEmpty ? nil : trimmedURL
        guard let api = appState.api else {
            errorMessage = "Backend URL is not configured."
            return
        }
        errorMessage = nil
        isWorking = true

        Task {
            do {
                let title = jobTitle.trimmingCharacters(in: .whitespaces)
                let auth = try await api.devLogin(name: name.trimmingCharacters(in: .whitespaces))
                let org: ProtocolOrg
                switch mode {
                case .create:
                    org = try await api.createOrg(
                        token: auth.token,
                        name: orgName.trimmingCharacters(in: .whitespaces),
                        title: title.isEmpty ? "Founder" : title
                    )
                case .join:
                    org = try await api.acceptInvite(
                        token: auth.token,
                        code: inviteCode.trimmingCharacters(in: .whitespaces),
                        title: title.isEmpty ? "Member" : title
                    )
                }
                let user = User(
                    id: auth.user.id,
                    name: auth.user.name,
                    role: title,
                    teamID: nil,
                    githubUsername: nil
                )
                await appState.activateSession(
                    token: auth.token,
                    user: user,
                    orgID: org.id,
                    orgName: org.name
                )
            } catch {
                errorMessage = error.localizedDescription
            }
            isWorking = false
        }
    }
}

#Preview {
    AuthView()
        .environmentObject(AppState())
}
