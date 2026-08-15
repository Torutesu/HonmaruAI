import SwiftUI
import UIKit
import UserNotifications

/// A6 — iOS inset-grouped settings on white cards, radius 16, hairline
/// separators. This is where the account actions live now; they used to hide
/// behind an ellipsis menu on the feed.
struct YouView: View {
    @EnvironmentObject private var appState: AppState
    @EnvironmentObject private var push: PushService

    @State private var showOrgGraph = false
    @State private var showConnectGitHub = false

    var body: some View {
        NavigationStack {
        ScrollView {
            VStack(spacing: Theme.Spacing.md) {
                header

                group {
                    row(String(localized: "Your AI"), value: appState.aiService.isConfigured ? String(localized: "Connected") : String(localized: "Not set"))
                    row(String(localized: "Relay"), value: relayHost)
                    row(String(localized: "GitHub"), value: appState.githubService.connection?.repository ?? String(localized: "Not connected")) {
                        showConnectGitHub = true
                    }
                }

                group {
                    navRow(String(localized: "Plan")) { SubscriptionView() }
                    navRow(String(localized: "API key")) { APIKeyView() }
                    navRow(String(localized: "Context")) { ContextView() }
                    navRow(String(localized: "Connectors")) { ConnectorsView() }
                }

                group {
                    navRow(String(localized: "History")) { HistoryView() }
                    notificationsRow
                }

                group {
                    row(String(localized: "Organization"), value: "") { showOrgGraph = true }
                }

                group {
                    Picker(selection: $appState.language) {
                        ForEach(AppLanguage.allCases) { lang in
                            Text(lang.label).tag(lang)
                        }
                    } label: {
                        Text("Language")
                    }
                    .pickerStyle(.menu)
                    .padding(.horizontal, Theme.Spacing.md)
                    .padding(.vertical, 13)
                    Picker(selection: $appState.appearance) {
                        ForEach(AppAppearance.allCases) { mode in
                            Text(mode.label).tag(mode)
                        }
                    } label: {
                        Text("Appearance")
                    }
                    .pickerStyle(.menu)
                    .padding(.horizontal, Theme.Spacing.md)
                    .padding(.vertical, 13)
                    row(String(localized: "Version"), value: versionString)
                }

                Button(String(localized: "Sign out")) {
                    appState.signOut()
                }
                .font(.system(size: 15, weight: .medium))
                .foregroundStyle(Theme.Colors.reject)
                .padding(.top, Theme.Spacing.sm)

                // Apple requires account deletion to be reachable in the app for
                // anything that lets you create an account (Guideline 5.1.1(v)).
                // A guest has no account to delete, so the row is not offered.
                if !appState.isGuest {
                    NavigationLink {
                        DeleteAccountView().environmentObject(appState)
                    } label: {
                        Text("Delete account")
                            .font(.system(size: 13))
                            .foregroundStyle(Theme.Colors.textTertiary)
                    }
                    .buttonStyle(.plain)
                    .padding(.top, Theme.Spacing.xs)
                }
            }
            .padding(.horizontal, Theme.Spacing.md)
            .padding(.top, Theme.Spacing.lg)
            .padding(.bottom, Theme.Spacing.xxl)
        }
        .sheet(isPresented: $showOrgGraph) {
            OrgGraphView()
                .environmentObject(appState)
        }
        .sheet(isPresented: $showConnectGitHub) {
            ConnectGitHubSheet(context: .settings)
                .environmentObject(appState)
                .presentationDetents([.medium, .large])
                .presentationBackground(Theme.Colors.surface)
        }
        } // NavigationStack
    }

    private var versionString: String {
        let info = Bundle.main.infoDictionary
        let short = info?["CFBundleShortVersionString"] as? String ?? "—"
        let build = info?["CFBundleVersion"] as? String ?? "—"
        return "\(short) (\(build))"
    }

    private var relayHost: String {
        appState.relayURL
            .replacingOccurrences(of: "ws://", with: "")
            .replacingOccurrences(of: "wss://", with: "")
    }

    private var header: some View {
        HStack(spacing: Theme.Spacing.sm) {
            Text(String(appState.currentUser?.name.prefix(1) ?? "?"))
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(Theme.Colors.textSecondary)
                .frame(width: 40, height: 40)
                .background(Theme.Colors.surfaceRaised)
                .clipShape(Circle())

            VStack(alignment: .leading, spacing: 1) {
                Text(appState.currentUser?.name ?? "")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(Theme.Colors.textPrimary)
                Text(appState.currentUser?.role ?? "")
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.Colors.textTertiary)
            }

            Spacer()
        }
        .padding(Theme.Spacing.md)
        .background(Theme.Colors.background)
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.image))
        .overlay {
            RoundedRectangle(cornerRadius: Theme.Radius.image)
                .strokeBorder(Theme.Colors.border, lineWidth: 1)
        }
    }

    private func group<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        VStack(spacing: 0) { content() }
            .background(Theme.Colors.background)
            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.image))
            .overlay {
                RoundedRectangle(cornerRadius: Theme.Radius.image)
                    .strokeBorder(Theme.Colors.border, lineWidth: 1)
            }
    }

    /// Notifications, and the way back from a "Don't Allow".
    ///
    /// iOS never shows the prompt twice, so once it has been refused the only
    /// honest thing an in-app toggle can do is open Settings. Pretending
    /// otherwise produces a switch that flips back on its own.
    @ViewBuilder
    private var notificationsRow: some View {
        if !PushService.isEnabledInThisBuild {
            // A control that asks for a permission this build cannot use would
            // spend the one prompt iOS gives us on nothing. Say so instead.
            HStack {
                Text("Notifications")
                    .font(.system(size: 15))
                    .foregroundStyle(Theme.Colors.textTertiary)
                Spacer()
                Text("Coming soon")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(Theme.Colors.textTertiary)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 3)
                    .background(Theme.Colors.surfaceRaised)
                    .clipShape(Capsule())
            }
            .padding(.horizontal, Theme.Spacing.md)
            .padding(.vertical, 13)
        } else {
            liveNotificationsRow
        }
    }

    private var liveNotificationsRow: some View {
        Button {
            switch push.authorization {
            case .notDetermined:
                Task { await push.requestAuthorizationIfEarned() }
            default:
                if let url = URL(string: UIApplication.openSettingsURLString) {
                    UIApplication.shared.open(url)
                }
            }
        } label: {
            HStack {
                Text("Notifications")
                    .font(.system(size: 15))
                    .foregroundStyle(Theme.Colors.textPrimary)
                Spacer()
                Text(notificationStatusLabel)
                    .font(.system(size: 14))
                    .foregroundStyle(Theme.Colors.textTertiary)
                Image(systemName: "chevron.right")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(Theme.Colors.textTertiary)
            }
            .padding(.horizontal, Theme.Spacing.md)
            .padding(.vertical, 13)
        }
        .buttonStyle(.plain)
    }

    private var notificationStatusLabel: String {
        switch push.authorization {
        case .authorized, .provisional, .ephemeral: String(localized: "On")
        case .denied: String(localized: "Off — open Settings")
        default: String(localized: "Turn on")
        }
    }

    /// A row that pushes a real screen, styled like `row(_:value:)`.
    private func navRow<Destination: View>(
        _ title: String,
        @ViewBuilder destination: @escaping () -> Destination
    ) -> some View {
        NavigationLink { destination().environmentObject(appState) } label: {
            HStack {
                Text(title)
                    .font(.system(size: 15))
                    .foregroundStyle(Theme.Colors.textPrimary)
                Spacer()
                Image(systemName: "chevron.right")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(Theme.Colors.textTertiary)
            }
            .padding(.horizontal, Theme.Spacing.md)
            .padding(.vertical, 13)
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder
    private func row(_ title: String, value: String, action: (() -> Void)? = nil) -> some View {
        let content = HStack {
            Text(title)
                .font(.system(size: 15))
                .foregroundStyle(Theme.Colors.textPrimary)
            Spacer()
            Text(value)
                .font(.system(size: 14))
                .foregroundStyle(Theme.Colors.textTertiary)
                .lineLimit(1)
            if action != nil {
                Image(systemName: "chevron.right")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(Theme.Colors.textTertiary)
            }
        }
        .padding(.horizontal, Theme.Spacing.md)
        .padding(.vertical, 13)

        if let action {
            Button(action: action) { content }.buttonStyle(.plain)
        } else {
            content
        }
    }
}

#Preview {
    YouView()
        .environmentObject(AppState())
        .environmentObject(PushService.shared)
}
