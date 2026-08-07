import SwiftUI

// MARK: - Shared rows

private func settingsInfoRow(_ label: String, _ value: String) -> some View {
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

private func settingsSectionTitle(_ title: String) -> some View {
    Text(title)
        .font(Theme.TypeScale.micro)
        .foregroundStyle(Theme.Colors.textTertiary)
        .textCase(.uppercase)
        .tracking(0.8)
}

// MARK: - Profile

struct ProfileSettingsView: View {
    @EnvironmentObject private var appState: AppState
    @State private var showSwitcher = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Spacing.xl) {
                VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                    settingsSectionTitle("Identity")
                    VStack(spacing: 1) {
                        settingsInfoRow("Name", appState.currentUser?.name ?? "")
                        settingsInfoRow("Role", appState.currentUser?.role ?? "")
                        settingsInfoRow("Your AI", DemoData.agentName(for: appState.currentUser?.id ?? ""))
                        settingsInfoRow("GitHub", appState.githubService.connection?.username ?? "Not linked")
                    }
                    .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))
                }

                PrimaryButton(title: "Switch identity") {
                    showSwitcher = true
                }

                Text("Switching identity reconnects the feed as another member of the demo org.")
                    .font(Theme.TypeScale.micro)
                    .foregroundStyle(Theme.Colors.textTertiary)
            }
            .padding(Theme.Spacing.screen)
        }
        .background(Theme.Colors.background)
        .navigationTitle("Profile")
        .navigationBarTitleDisplayMode(.inline)
        .sheet(isPresented: $showSwitcher) {
            UserSwitcherSheet { user in
                Task { await appState.switchUser(to: user.user) }
            }
            .environmentObject(appState)
        }
    }
}

// MARK: - Context

struct ContextSettingsView: View {
    @EnvironmentObject private var preferences: AppPreferences

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Spacing.xl) {
                VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                    settingsSectionTitle("Card tone")
                    Picker("Tone", selection: toneBinding) {
                        ForEach(AITone.allCases) { tone in
                            Text(tone.label).tag(tone)
                        }
                    }
                    .pickerStyle(.segmented)
                    Text("How your AI phrases decision cards it drafts for others.")
                        .font(Theme.TypeScale.micro)
                        .foregroundStyle(Theme.Colors.textTertiary)
                }

                VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                    settingsSectionTitle("Autonomy")
                    VStack(spacing: Theme.Spacing.sm) {
                        ForEach(AIAutonomy.allCases) { level in
                            Button {
                                Haptics.light()
                                preferences.autonomy = level
                            } label: {
                                HStack {
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(level.label)
                                            .font(.system(size: 15, weight: .medium))
                                            .foregroundStyle(Theme.Colors.textPrimary)
                                        Text(level.detail)
                                            .font(Theme.TypeScale.label)
                                            .foregroundStyle(Theme.Colors.textTertiary)
                                    }
                                    Spacer()
                                    if preferences.autonomy == level {
                                        Image(systemName: "checkmark")
                                            .font(.system(size: 12, weight: .semibold))
                                            .foregroundStyle(Theme.Colors.accent)
                                    }
                                }
                                .padding(Theme.Spacing.md)
                                .background(Theme.Colors.surface)
                                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }

                Toggle(isOn: quietHoursBinding) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Quiet hours")
                            .font(.system(size: 15, weight: .medium))
                            .foregroundStyle(Theme.Colors.textPrimary)
                        Text("Hold non-urgent cards overnight")
                            .font(Theme.TypeScale.label)
                            .foregroundStyle(Theme.Colors.textTertiary)
                    }
                }
                .tint(Theme.Colors.accent)
                .padding(Theme.Spacing.md)
                .background(Theme.Colors.surface)
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))
            }
            .padding(Theme.Spacing.screen)
        }
        .background(Theme.Colors.background)
        .navigationTitle("Context")
        .navigationBarTitleDisplayMode(.inline)
    }

    private var toneBinding: Binding<AITone> {
        Binding(
            get: { preferences.tone },
            set: { preferences.tone = $0 }
        )
    }

    private var quietHoursBinding: Binding<Bool> {
        Binding(
            get: { preferences.quietHours },
            set: { preferences.quietHours = $0 }
        )
    }
}

// MARK: - Billing

struct BillingSettingsView: View {
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                planCard(
                    name: "Free",
                    price: "¥0",
                    detail: "Demo org · 4 seats · GitHub sync",
                    current: true
                )
                planCard(
                    name: "Team",
                    price: "¥1,800 / seat / month",
                    detail: "Unlimited seats · all integrations · priority routing",
                    current: false
                )

                Text("Billing is not wired in this MVP — plans are illustrative.")
                    .font(Theme.TypeScale.micro)
                    .foregroundStyle(Theme.Colors.textTertiary)
                    .padding(.top, Theme.Spacing.sm)
            }
            .padding(Theme.Spacing.screen)
        }
        .background(Theme.Colors.background)
        .navigationTitle("Billing")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func planCard(name: String, price: String, detail: String, current: Bool) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            HStack {
                Text(name)
                    .font(.system(size: 17, weight: .medium))
                    .foregroundStyle(Theme.Colors.textPrimary)
                Spacer()
                if current {
                    Text("Current plan")
                        .font(Theme.TypeScale.micro)
                        .foregroundStyle(Theme.Colors.approve)
                }
            }
            Text(price)
                .font(Theme.TypeScale.body)
                .foregroundStyle(Theme.Colors.textSecondary)
            Text(detail)
                .font(Theme.TypeScale.label)
                .foregroundStyle(Theme.Colors.textTertiary)
        }
        .padding(Theme.Spacing.md)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.Colors.surface)
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))
        .overlay(
            RoundedRectangle(cornerRadius: Theme.Radius.md)
                .strokeBorder(current ? Theme.Colors.accent : .clear, lineWidth: 1)
        )
    }
}

// MARK: - Security

struct SecuritySettingsView: View {
    @EnvironmentObject private var appState: AppState
    @State private var showRevokeConfirm = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Spacing.xl) {
                VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                    settingsSectionTitle("Access")
                    VStack(spacing: 1) {
                        settingsInfoRow("GitHub token", "Stored in the device Keychain")
                        settingsInfoRow("OAuth secret", "Never leaves the localhost relay")
                        settingsInfoRow("Relay", appState.relayURL)
                        settingsInfoRow("Cards", "Held in memory · synced via relay")
                    }
                    .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))
                }

                SecondaryAction(title: "Revoke GitHub access", tint: Theme.Colors.reject) {
                    showRevokeConfirm = true
                }
                .frame(maxWidth: .infinity)

                Text("Revoking clears the stored token and signs you out.")
                    .font(Theme.TypeScale.micro)
                    .foregroundStyle(Theme.Colors.textTertiary)
                    .frame(maxWidth: .infinity, alignment: .center)
            }
            .padding(Theme.Spacing.screen)
        }
        .background(Theme.Colors.background)
        .navigationTitle("Security")
        .navigationBarTitleDisplayMode(.inline)
        .confirmationDialog(
            "Revoke GitHub access and sign out?",
            isPresented: $showRevokeConfirm,
            titleVisibility: .visible
        ) {
            Button("Revoke & sign out", role: .destructive) { appState.signOut() }
            Button("Cancel", role: .cancel) {}
        }
    }
}

// MARK: - Language

struct LanguageSettingsView: View {
    @EnvironmentObject private var preferences: AppPreferences

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                VStack(spacing: Theme.Spacing.sm) {
                    ForEach(AppLanguage.allCases) { language in
                        Button {
                            Haptics.light()
                            preferences.language = language
                        } label: {
                            HStack {
                                Text(language.label)
                                    .font(.system(size: 15, weight: .medium))
                                    .foregroundStyle(Theme.Colors.textPrimary)
                                Spacer()
                                if preferences.language == language {
                                    Image(systemName: "checkmark")
                                        .font(.system(size: 12, weight: .semibold))
                                        .foregroundStyle(Theme.Colors.accent)
                                }
                            }
                            .padding(Theme.Spacing.md)
                            .background(Theme.Colors.surface)
                            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))
                        }
                        .buttonStyle(.plain)
                    }
                }

                Text("Sets the language your AI prefers for summaries and decision cards. UI localization ships after the MVP.")
                    .font(Theme.TypeScale.micro)
                    .foregroundStyle(Theme.Colors.textTertiary)
            }
            .padding(Theme.Spacing.screen)
        }
        .background(Theme.Colors.background)
        .navigationTitle("Language")
        .navigationBarTitleDisplayMode(.inline)
    }
}

#Preview {
    NavigationStack {
        ContextSettingsView()
            .environmentObject(AppPreferences())
    }
}
