import SwiftUI
import UIKit
import UserNotifications

/// Workspace and personal settings are separate, with real membership and
/// connection state visible before optional account preferences.
struct YouView: View {
    var onCompose: () -> Void = {}
    @EnvironmentObject private var appState: AppState
    @EnvironmentObject private var push: PushService
    @State private var showConnectGitHub = false
    @State private var showResetDemo = false
    @State private var showSignOut = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 28) {
                    workspaceCard
                    if appState.isGuest { demoConnectionCard }
                    membersSection
                    connectionsSection
                    preferencesSection
                    accountSection
                    Text("Version \(versionString)")
                        .font(.caption)
                        .foregroundStyle(Theme.Colors.textTertiary)
                        .frame(maxWidth: .infinity)
                        .padding(.bottom, 12)
                }
                .padding(.horizontal, 20)
                .padding(.top, 12)
                .padding(.bottom, 24)
            }
            .background(Theme.Colors.surface)
            .navigationTitle("Workspace")
            .navigationBarTitleDisplayMode(.large)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button(action: onCompose) { Label("New request", systemImage: "square.and.pencil") }
                }
            }
            .refreshable { await appState.refreshWorkspaceMembers() }
            .task { await appState.refreshWorkspaceMembers() }
            .sheet(isPresented: $showConnectGitHub) {
                ConnectGitHubSheet(context: .settings)
                    .environmentObject(appState)
                    .presentationDetents([.large])
            }
            .confirmationDialog("Reset sample requests?", isPresented: $showResetDemo, titleVisibility: .visible) {
                Button("Reset demo") { appState.resetDemoWorkspace() }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("This replaces your demo changes with the original samples. Your real workspace is unaffected.")
            }
            .confirmationDialog(appState.isGuest ? String(localized: "Leave the demo?") : String(localized: "Sign out of this workspace?"), isPresented: $showSignOut, titleVisibility: .visible) {
                Button(appState.isGuest ? String(localized: "Exit demo") : String(localized: "Sign out"), role: .destructive) { appState.signOut() }
                Button("Cancel", role: .cancel) {}
            }
        }
        .tint(Theme.Colors.interactive)
    }

    private var workspaceCard: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(spacing: 14) {
                Image(systemName: appState.isGuest ? "square.stack.3d.up" : "building.2")
                    .font(.title2.weight(.medium))
                    .foregroundStyle(Theme.Colors.accent)
                    .frame(width: 52, height: 52)
                    .background(Theme.Colors.accent.opacity(0.09), in: RoundedRectangle(cornerRadius: 15))
                VStack(alignment: .leading, spacing: 5) {
                    Text(appState.workspaceDisplayName)
                        .font(.title3.weight(.semibold))
                        .foregroundStyle(Theme.Colors.textPrimary)
                        .fixedSize(horizontal: false, vertical: true)
                    Label(connectionDescription, systemImage: appState.isGuest ? "circle.dotted" : "circle.fill")
                        .font(.caption.weight(.medium))
                        .foregroundStyle(appState.isGuest ? Theme.Colors.accent : connectionColor)
                }
                Spacer(minLength: 0)
            }
            Divider().overlay(Theme.Colors.border)
            HStack(spacing: 10) {
                initialsAvatar(appState.currentUser?.name ?? String(localized: "You"), size: 32)
                VStack(alignment: .leading, spacing: 3) {
                    Text(appState.isGuest ? String(localized: "You · Demo account") : (appState.currentUser?.name ?? String(localized: "You")))
                        .font(.subheadline.weight(.medium))
                    Text(appState.isGuest ? String(localized: "Your changes stay in this demo") : String(localized: "Your active workspace"))
                        .font(.caption).foregroundStyle(Theme.Colors.textSecondary)
                }
                Spacer(minLength: 0)
            }
        }
        .padding(20)
        .background(Theme.Colors.background, in: RoundedRectangle(cornerRadius: 20))
        .overlay(RoundedRectangle(cornerRadius: 20).strokeBorder(Theme.Colors.border, lineWidth: 1))
    }

    private var demoConnectionCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Ready to work with your team?").font(.headline)
            Text("Connect GitHub to use your repository's real members and requests.")
                .font(.subheadline).foregroundStyle(Theme.Colors.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
            PrimaryButton(title: String(localized: "Connect GitHub")) { showConnectGitHub = true }
        }
        .padding(20)
        .background(Theme.Colors.accent.opacity(0.055), in: RoundedRectangle(cornerRadius: 18))
    }

    private var membersSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            sectionHeader("People", count: appState.workspaceMembers.count)
            group {
                if appState.membersLoading && appState.workspaceMembers.isEmpty {
                    ProgressView("Loading your team…").font(.subheadline).padding(20)
                        .frame(maxWidth: .infinity, alignment: .leading)
                } else if let error = appState.membersError, appState.workspaceMembers.isEmpty {
                    VStack(alignment: .leading, spacing: 12) {
                        Label("We couldn't load your team", systemImage: "exclamationmark.circle")
                            .font(.subheadline.weight(.medium))
                        Text(error).font(.caption).foregroundStyle(Theme.Colors.textSecondary)
                        Button("Try again") { Task { await appState.refreshWorkspaceMembers() } }
                            .font(.subheadline.weight(.semibold))
                    }.padding(18)
                } else if appState.workspaceMembers.isEmpty {
                    Text("Connect a workspace to see your team here.")
                        .font(.subheadline).foregroundStyle(Theme.Colors.textSecondary).padding(18)
                } else {
                    ForEach(Array(appState.workspaceMembers.enumerated()), id: \.element.id) { index, member in
                        if index > 0 { rowDivider }
                        HStack(spacing: 12) {
                            initialsAvatar(member.name, size: 38)
                            VStack(alignment: .leading, spacing: 4) {
                                Text(member.name).font(.subheadline.weight(.medium))
                                    .foregroundStyle(Theme.Colors.textPrimary)
                                if !member.role.isEmpty {
                                    Text(member.role).font(.caption).foregroundStyle(Theme.Colors.textSecondary)
                                }
                            }
                            Spacer(minLength: 0)
                            if member.id == appState.currentUser?.id {
                                Text("You").font(.caption.weight(.medium))
                                    .foregroundStyle(Theme.Colors.textSecondary)
                                    .padding(.horizontal, 8).padding(.vertical, 4)
                                    .background(Theme.Colors.surfaceRaised, in: Capsule())
                            }
                        }.padding(16)
                    }
                }
            }
            Text(appState.isGuest ? String(localized: "Sample teammates for trying the workflow.") : String(localized: "People who belong to this workspace."))
                .font(.caption).foregroundStyle(Theme.Colors.textTertiary)
                .padding(.horizontal, 4)
        }
    }

    private var connectionsSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            sectionHeader("Connections")
            group {
                settingsRow("GitHub", subtitle: appState.githubService.connection?.repository ?? String(localized: "Connect your repository"), symbol: "chevron.left.forwardslash.chevron.right") {
                    showConnectGitHub = true
                }
                rowDivider
                if !appState.isGuest {
                    NavigationLink { ConnectorsView().environmentObject(appState) } label: {
                        rowContent("Connected tools", subtitle: String(localized: "Sources for your team's work"), symbol: "square.grid.2x2", showsChevron: true)
                    }.buttonStyle(.plain)
                    rowDivider
                }
                rowContent("AI assistance", subtitle: appState.isGuest ? String(localized: "Demo suggestions · no external AI calls") : (appState.aiService.isConfigured ? String(localized: "Available for request drafts") : String(localized: "You can still create requests manually")), symbol: "sparkles", showsChevron: false)
            }
        }
    }

    private var preferencesSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            sectionHeader("Preferences")
            group {
                Picker(selection: $appState.language) {
                    ForEach(AppLanguage.allCases) { Text($0.label).tag($0) }
                } label: { Label("Language", systemImage: "globe") }
                    .font(.subheadline).padding(16)
                rowDivider
                Picker(selection: $appState.appearance) {
                    ForEach(AppAppearance.allCases) { Text($0.label).tag($0) }
                } label: { Label("Appearance", systemImage: "circle.lefthalf.filled") }
                    .font(.subheadline).padding(16)
                rowDivider
                if PushService.isEnabledInThisBuild && !appState.isGuest {
                    settingsRow("Notifications", subtitle: notificationStatusLabel, symbol: "bell") {
                        switch push.authorization {
                        case .notDetermined: Task { await push.requestAuthorizationIfEarned() }
                        default:
                            if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
                        }
                    }
                } else {
                    rowContent("Notifications", subtitle: String(localized: "Not available in this version"), symbol: "bell.slash", showsChevron: false)
                }
            }
        }
    }

    private var accountSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            sectionHeader(appState.isGuest ? "Demo workspace" : "Account")
            group {
                if appState.isGuest {
                    settingsRow("Reset demo", subtitle: String(localized: "Start again with the sample requests"), symbol: "arrow.counterclockwise") { showResetDemo = true }
                } else {
                    NavigationLink { ContextView().environmentObject(appState) } label: {
                        rowContent("Your work context", subtitle: String(localized: "Help AI understand your role"), symbol: "person.text.rectangle", showsChevron: true)
                    }.buttonStyle(.plain)
                    rowDivider
                    NavigationLink { SubscriptionView().environmentObject(appState) } label: {
                        rowContent("Plan and usage", subtitle: String(localized: "Manage your subscription"), symbol: "creditcard", showsChevron: true)
                    }.buttonStyle(.plain)
                    rowDivider
                    NavigationLink { APIKeyView().environmentObject(appState) } label: {
                        rowContent("AI provider", subtitle: String(localized: "Optional provider settings"), symbol: "key", showsChevron: true)
                    }.buttonStyle(.plain)
                }
                rowDivider
                settingsRow(appState.isGuest ? "Exit demo" : "Sign out", subtitle: nil, symbol: "rectangle.portrait.and.arrow.right") { showSignOut = true }
                if !appState.isGuest {
                    rowDivider
                    NavigationLink { DeleteAccountView().environmentObject(appState) } label: {
                        rowContent("Delete account", subtitle: nil, symbol: "trash", showsChevron: true)
                            .foregroundStyle(Theme.Colors.reject)
                    }.buttonStyle(.plain)
                }
            }
        }
    }

    private var connectionDescription: String {
        if appState.isGuest { return String(localized: "Demo workspace") }
        switch appState.connectionState {
        case .connected: return String(localized: "Connected")
        case .connecting: return String(localized: "Connecting…")
        case .offline: return String(localized: "Offline · showing saved requests")
        case .refused: return String(localized: "Reconnect your workspace")
        }
    }
    private var connectionColor: Color {
        appState.connectionState == .connected ? Theme.Colors.approve : Theme.Colors.textSecondary
    }
    private var versionString: String {
        let info = Bundle.main.infoDictionary
        return "\(info?["CFBundleShortVersionString"] as? String ?? "—") (\(info?["CFBundleVersion"] as? String ?? "—"))"
    }
    private var notificationStatusLabel: String {
        switch push.authorization {
        case .authorized, .provisional, .ephemeral: String(localized: "On")
        case .denied: String(localized: "Off — open Settings")
        default: String(localized: "Turn on")
        }
    }
    private var rowDivider: some View { Divider().overlay(Theme.Colors.border).padding(.leading, 56) }
    private func sectionHeader(_ title: LocalizedStringKey, count: Int? = nil) -> some View {
        HStack(spacing: 8) {
            Text(title).font(.subheadline.weight(.semibold))
            if let count { Text("\(count)").font(.caption.weight(.medium)).foregroundStyle(Theme.Colors.textTertiary) }
            Spacer()
        }.foregroundStyle(Theme.Colors.textPrimary).padding(.horizontal, 4)
    }
    private func group<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        VStack(spacing: 0) { content() }.frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.Colors.background, in: RoundedRectangle(cornerRadius: 16))
            .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(Theme.Colors.border, lineWidth: 1))
    }
    private func initialsAvatar(_ name: String, size: CGFloat) -> some View {
        Text(name.split(separator: " ").prefix(2).compactMap(\.first).map(String.init).joined().uppercased())
            .font(.system(size: size * 0.34, weight: .semibold))
            .foregroundStyle(Theme.Colors.accent)
            .frame(width: size, height: size)
            .background(Theme.Colors.accent.opacity(0.09), in: Circle())
            .accessibilityHidden(true)
    }
    private func rowContent(_ title: LocalizedStringKey, subtitle: String?, symbol: String, showsChevron: Bool) -> some View {
        HStack(spacing: 12) {
            Image(systemName: symbol).font(.system(size: 17)).foregroundStyle(Theme.Colors.textSecondary)
                .frame(width: 24)
            VStack(alignment: .leading, spacing: 5) {
                Text(title).font(.subheadline.weight(.medium)).foregroundStyle(Theme.Colors.textPrimary)
                if let subtitle { Text(subtitle).font(.caption).foregroundStyle(Theme.Colors.textSecondary).fixedSize(horizontal: false, vertical: true) }
            }
            Spacer(minLength: 0)
            if showsChevron { Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(Theme.Colors.textTertiary) }
        }
        .padding(16)
        .frame(minHeight: 54)
        .contentShape(Rectangle())
    }
    private func settingsRow(_ title: LocalizedStringKey, subtitle: String?, symbol: String, action: @escaping () -> Void) -> some View {
        Button(action: action) { rowContent(title, subtitle: subtitle, symbol: symbol, showsChevron: true) }.buttonStyle(.plain)
    }
}
