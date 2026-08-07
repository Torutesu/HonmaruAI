import SwiftUI

struct IntegrationsView: View {
    @EnvironmentObject private var appState: AppState
    @EnvironmentObject private var preferences: AppPreferences

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                    Text("Your AI acts through these tools when decisions are approved.")
                        .font(Theme.TypeScale.caption)
                        .foregroundStyle(Theme.Colors.textTertiary)

                    VStack(spacing: Theme.Spacing.sm) {
                        ForEach(WorkTool.allCases) { tool in
                            NavigationLink {
                                IntegrationDetailView(tool: tool)
                            } label: {
                                row(tool)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
                .padding(Theme.Spacing.screen)
            }
            .background(Theme.Colors.background)
            .navigationTitle("Integrations")
            .navigationBarTitleDisplayMode(.inline)
        }
    }

    private func row(_ tool: WorkTool) -> some View {
        let connected = preferences.isConnected(tool, githubService: appState.githubService)
        return HStack(spacing: Theme.Spacing.md) {
            Image(systemName: tool.icon)
                .font(.system(size: 14))
                .foregroundStyle(Theme.Colors.textSecondary)
                .frame(width: 36, height: 36)
                .background(Theme.Colors.surfaceRaised)
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))

            VStack(alignment: .leading, spacing: 2) {
                Text(tool.label)
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(Theme.Colors.textPrimary)
                HStack(spacing: 5) {
                    Circle()
                        .fill(connected ? Theme.Colors.approve : Theme.Colors.textTertiary)
                        .frame(width: 5, height: 5)
                    Text(connected ? "Connected" : "Not connected")
                        .font(Theme.TypeScale.label)
                        .foregroundStyle(connected ? Theme.Colors.textSecondary : Theme.Colors.textTertiary)
                }
            }

            Spacer()

            Image(systemName: "chevron.right")
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(Theme.Colors.textTertiary)
        }
        .padding(Theme.Spacing.md)
        .background(Theme.Colors.surface)
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))
    }
}

struct IntegrationDetailView: View {
    @EnvironmentObject private var appState: AppState
    @EnvironmentObject private var preferences: AppPreferences
    let tool: WorkTool

    @State private var isWorking = false
    @State private var showSignOutConfirm = false

    private var connected: Bool {
        preferences.isConnected(tool, githubService: appState.githubService)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Spacing.xl) {
                header

                Text(tool.blurb)
                    .font(Theme.TypeScale.body)
                    .foregroundStyle(Theme.Colors.textSecondary)
                    .lineSpacing(4)

                VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                    Text("What your AI can do")
                        .font(Theme.TypeScale.micro)
                        .foregroundStyle(Theme.Colors.textTertiary)
                        .textCase(.uppercase)
                        .tracking(0.8)

                    ForEach(tool.capabilities, id: \.self) { capability in
                        HStack(alignment: .top, spacing: Theme.Spacing.sm) {
                            Image(systemName: "checkmark")
                                .font(.system(size: 10, weight: .semibold))
                                .foregroundStyle(connected ? Theme.Colors.approve : Theme.Colors.textTertiary)
                                .padding(.top, 3)
                            Text(capability)
                                .font(Theme.TypeScale.caption)
                                .foregroundStyle(Theme.Colors.textSecondary)
                        }
                    }
                }

                if tool == .github {
                    githubDetails
                } else {
                    mockControls
                }
            }
            .padding(Theme.Spacing.screen)
        }
        .background(Theme.Colors.background)
        .navigationTitle(tool.label)
        .navigationBarTitleDisplayMode(.inline)
        .confirmationDialog(
            "Disconnecting GitHub signs you out of this session.",
            isPresented: $showSignOutConfirm,
            titleVisibility: .visible
        ) {
            Button("Disconnect & sign out", role: .destructive) {
                appState.signOut()
            }
            Button("Cancel", role: .cancel) {}
        }
    }

    private var header: some View {
        HStack(spacing: Theme.Spacing.md) {
            Image(systemName: tool.icon)
                .font(.system(size: 18))
                .foregroundStyle(Theme.Colors.textPrimary)
                .frame(width: 48, height: 48)
                .background(Theme.Colors.surfaceRaised)
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))

            VStack(alignment: .leading, spacing: 2) {
                Text(tool.label)
                    .font(.system(size: 17, weight: .medium))
                    .foregroundStyle(Theme.Colors.textPrimary)
                HStack(spacing: 5) {
                    Circle()
                        .fill(connected ? Theme.Colors.approve : Theme.Colors.textTertiary)
                        .frame(width: 5, height: 5)
                    Text(connected ? "Connected" : "Not connected")
                        .font(Theme.TypeScale.label)
                        .foregroundStyle(Theme.Colors.textTertiary)
                }
            }

            Spacer()
        }
    }

    private var githubDetails: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            if let connection = appState.githubService.connection {
                VStack(spacing: 1) {
                    detailRow("Account", connection.username)
                    detailRow("Repository", connection.repository)
                    detailRow("Sync", "Issues API · status polled every 30s")
                }
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))

                Text("Your OAuth secret stays on the localhost relay — the app only holds a token.")
                    .font(Theme.TypeScale.micro)
                    .foregroundStyle(Theme.Colors.textTertiary)

                SecondaryAction(title: "Disconnect GitHub", tint: Theme.Colors.reject) {
                    showSignOutConfirm = true
                }
                .frame(maxWidth: .infinity)
                .padding(.top, Theme.Spacing.sm)
            } else {
                Text("GitHub connects during onboarding. Sign out and back in to relink.")
                    .font(Theme.TypeScale.caption)
                    .foregroundStyle(Theme.Colors.textTertiary)
            }
        }
    }

    private var mockControls: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            Button {
                toggleMock()
            } label: {
                Text(connected ? "Disconnect \(tool.label)" : "Connect \(tool.label)")
                    .font(.system(size: 15, weight: .medium))
                    .frame(maxWidth: .infinity)
                    .frame(height: 44)
                    .background(connected ? Theme.Colors.surfaceRaised : Theme.Colors.textPrimary)
                    .foregroundStyle(connected ? Theme.Colors.textSecondary : Theme.Colors.background)
                    .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))
            }
            .disabled(isWorking)
            .overlay {
                if isWorking {
                    ProgressView()
                        .controlSize(.small)
                        .tint(Theme.Colors.textSecondary)
                }
            }

            Text("Demo connection — \(tool.label) actions are simulated in this MVP.")
                .font(Theme.TypeScale.micro)
                .foregroundStyle(Theme.Colors.textTertiary)
        }
    }

    private func toggleMock() {
        isWorking = true
        Task {
            try? await Task.sleep(for: .milliseconds(500))
            preferences.toggle(tool)
            isWorking = false
            Haptics.light()
        }
    }

    private func detailRow(_ label: String, _ value: String) -> some View {
        HStack(alignment: .top) {
            Text(label)
                .font(Theme.TypeScale.caption)
                .foregroundStyle(Theme.Colors.textTertiary)
                .frame(width: 96, alignment: .leading)
            Text(value)
                .font(Theme.TypeScale.caption)
                .foregroundStyle(Theme.Colors.textPrimary)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(Theme.Spacing.md)
        .background(Theme.Colors.surface)
    }
}

#Preview {
    let state = AppState()
    IntegrationsView()
        .environmentObject(state)
        .environmentObject(state.preferences)
}
