import SwiftUI

struct SettingsView: View {
    @EnvironmentObject private var appState: AppState
    @EnvironmentObject private var preferences: AppPreferences
    @State private var showSignOutConfirm = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Theme.Spacing.xl) {
                    NavigationLink {
                        ProfileSettingsView()
                    } label: {
                        profileCard
                    }
                    .buttonStyle(.plain)

                    VStack(spacing: Theme.Spacing.sm) {
                        settingsLink(icon: "brain", title: "Context", detail: "How your AI drafts and acts") {
                            ContextSettingsView()
                        }
                        settingsLink(icon: "creditcard", title: "Billing", detail: "Plan and usage") {
                            BillingSettingsView()
                        }
                        settingsLink(icon: "lock", title: "Security", detail: "Tokens, relay, and data") {
                            SecuritySettingsView()
                        }
                        settingsLink(icon: "globe", title: "Language", detail: preferences.language.label) {
                            LanguageSettingsView()
                        }
                    }

                    SecondaryAction(title: "Sign out", tint: Theme.Colors.reject) {
                        showSignOutConfirm = true
                    }
                    .frame(maxWidth: .infinity)

                    Text("Honmaru AI · TikTok for Work MVP")
                        .font(Theme.TypeScale.micro)
                        .foregroundStyle(Theme.Colors.textTertiary)
                        .frame(maxWidth: .infinity)
                }
                .padding(Theme.Spacing.screen)
            }
            .background(Theme.Colors.background)
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
        }
        .confirmationDialog("Sign out of Honmaru AI?", isPresented: $showSignOutConfirm, titleVisibility: .visible) {
            Button("Sign out", role: .destructive) { appState.signOut() }
            Button("Cancel", role: .cancel) {}
        }
    }

    private var profileCard: some View {
        HStack(spacing: Theme.Spacing.md) {
            Text(String((appState.currentUser?.name ?? "?").prefix(1)))
                .font(.system(size: 18, weight: .medium))
                .foregroundStyle(Theme.Colors.textPrimary)
                .frame(width: 48, height: 48)
                .background(Theme.Colors.surfaceRaised)
                .clipShape(Circle())

            VStack(alignment: .leading, spacing: 2) {
                Text(appState.currentUser?.name ?? "")
                    .font(.system(size: 17, weight: .medium))
                    .foregroundStyle(Theme.Colors.textPrimary)
                Text(appState.currentUser?.role ?? "")
                    .font(Theme.TypeScale.label)
                    .foregroundStyle(Theme.Colors.textTertiary)
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

    private func settingsLink<Destination: View>(
        icon: String,
        title: String,
        detail: String,
        @ViewBuilder destination: @escaping () -> Destination
    ) -> some View {
        NavigationLink {
            destination()
        } label: {
            HStack(spacing: Theme.Spacing.md) {
                Image(systemName: icon)
                    .font(.system(size: 14))
                    .foregroundStyle(Theme.Colors.textSecondary)
                    .frame(width: 20)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(.system(size: 15, weight: .medium))
                        .foregroundStyle(Theme.Colors.textPrimary)
                    Text(detail)
                        .font(Theme.TypeScale.label)
                        .foregroundStyle(Theme.Colors.textTertiary)
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
        .buttonStyle(.plain)
    }
}

#Preview {
    let state = AppState()
    SettingsView()
        .environmentObject(state)
        .environmentObject(state.preferences)
}
