import SwiftUI
import UIKit
import UserNotifications

/// Figma Profile: identity, personal controls, then plan and sign out.
struct YouView: View {
    var onCompose: () -> Void = {}
    @EnvironmentObject private var appState: AppState
    @EnvironmentObject private var push: PushService
    @EnvironmentObject private var subscription: SubscriptionService
    @State private var showEmail = false
    @State private var showGitHub = false
    @State private var confirmSignOut = false
    @State private var confirmReset = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 14) {
                    identityCard
                    group {
                        NavigationLink { APIKeyView().environmentObject(appState) } label: { row("AI", icon: "sparkles") }
                        separator
                        Menu {
                            Picker("Language", selection: $appState.language) {
                                ForEach(AppLanguage.allCases) { Text($0.label).tag($0) }
                            }
                        } label: { row("Language", icon: "globe", value: appState.language.label) }
                        separator
                        Button(action: openNotifications) { row("Notifications", icon: "bell", value: notificationStatus) }.disabled(!PushService.isEnabledInThisBuild || appState.isGuest)
                        separator
                        NavigationLink { RequestHistoryView().environmentObject(appState) } label: { row("History", icon: "clock.arrow.circlepath") }
                    }
                    group {
                        NavigationLink { SubscriptionView().environmentObject(appState) } label: {
                            HStack(spacing: 12) {
                                Image(systemName: "crown").foregroundStyle(Theme.Colors.accent).frame(width: 25)
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(subscription.isPro ? "Honmaru Pro" : "Plan and usage").font(.subheadline)
                                    Text(subscription.isConfigured ? String(localized: "Manage your subscription") : String(localized: "Billing is not available in this build"))
                                        .font(.caption).foregroundStyle(Theme.Colors.textSecondary)
                                }
                                Spacer(minLength: 8)
                                Image(systemName: "chevron.right").font(.caption).foregroundStyle(Theme.Colors.textTertiary)
                            }.padding(14).background(Theme.Colors.surface, in: RoundedRectangle(cornerRadius: 17)).padding(12)
                        }
                        Button { confirmSignOut = true } label: { row(appState.isGuest ? "Exit demo" : "Sign out", icon: "rectangle.portrait.and.arrow.right", chevron: false) }
                    }
                    group {
                        NavigationLink { workspaceSettings } label: { row("Workspace", icon: "building.2", value: appState.isGuest ? String(localized: "Demo") : nil) }
                        separator
                        NavigationLink { ContextView().environmentObject(appState) } label: { row("Your work context", icon: "person.text.rectangle") }
                    }
                    Text("Version \(version)").font(.caption).foregroundStyle(Theme.Colors.textTertiary).padding(.top, 4)
                }.padding(.horizontal, 20).padding(.top, 14).padding(.bottom, 24)
            }
            .background(Theme.Colors.surface)
            .navigationTitle("Profile").navigationBarTitleDisplayMode(.inline)
            .task { await appState.refreshWorkspaceMembers() }
            .sheet(isPresented: $showEmail) { emailSheet }
            .sheet(isPresented: $showGitHub) { ConnectGitHubSheet(context: .settings).environmentObject(appState).presentationDetents([.large]) }
            .confirmationDialog(appState.isGuest ? String(localized: "Leave the demo?") : String(localized: "Sign out of this workspace?"), isPresented: $confirmSignOut, titleVisibility: .visible) {
                Button(appState.isGuest ? String(localized: "Exit demo") : String(localized: "Sign out"), role: .destructive) { appState.signOut() }
                Button("Cancel", role: .cancel) {}
            }
            .confirmationDialog("Reset sample requests?", isPresented: $confirmReset, titleVisibility: .visible) {
                Button("Reset demo") { appState.resetDemoWorkspace() }
                Button("Cancel", role: .cancel) {}
            } message: { Text("This replaces your demo changes with the original samples. Your real workspace is unaffected.") }
        }.tint(Theme.Colors.textPrimary)
    }

    private var identityCard: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(spacing: 12) {
                avatar
                VStack(alignment: .leading, spacing: 5) {
                    Text(appState.currentUser?.name ?? String(localized: "You")).font(.headline)
                    Text(appState.isGuest ? String(localized: "Demo workspace") : appState.workspaceDisplayName)
                        .font(.subheadline).foregroundStyle(Theme.Colors.textSecondary)
                }
                Spacer(minLength: 0)
            }
            HStack(spacing: 12) {
                Image(systemName: "sparkles").font(.title3).foregroundStyle(Theme.Colors.accent).frame(width: 30, height: 34)
                VStack(alignment: .leading, spacing: 4) {
                    Text("Your AI assistant").font(.subheadline)
                    Text(appState.isGuest ? String(localized: "Sample data only") : (appState.aiService.modelName ?? String(localized: "Manual requests are available")))
                        .font(.caption).foregroundStyle(Theme.Colors.textSecondary)
                }
                Spacer(minLength: 4)
                Text(appState.isGuest ? String(localized: "Demo") : (appState.aiService.isConfigured ? String(localized: "Configured") : String(localized: "Set up")))
                    .font(.caption.weight(.medium)).padding(.horizontal, 12).padding(.vertical, 8)
                    .foregroundStyle(Theme.Colors.ctaText).background(Theme.Colors.ctaFill, in: Capsule())
            }.padding(12).background(Theme.Colors.surface, in: RoundedRectangle(cornerRadius: 16))
        }.padding(16).frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.Colors.background, in: RoundedRectangle(cornerRadius: 22))
            .overlay(RoundedRectangle(cornerRadius: 22).stroke(Theme.Colors.border, lineWidth: 1))
    }

    private var avatar: some View {
        Group {
            if let raw = appState.workspaceMembers.first(where: { $0.id == appState.currentUser?.id })?.avatarUrl, let url = URL(string: raw) {
                AsyncImage(url: url) { image in image.resizable().scaledToFill() } placeholder: { Image(systemName: "person.crop.circle.fill").resizable().foregroundStyle(Theme.Colors.textTertiary) }
            } else { Image(systemName: "person.crop.circle.fill").resizable().foregroundStyle(Theme.Colors.textTertiary) }
        }.frame(width: 48, height: 48).clipShape(Circle()).accessibilityHidden(true)
    }

    private var workspaceSettings: some View {
        List {
            if appState.isGuest {
                Section {
                    Text("Sample teammates for trying the workflow.").font(.subheadline).foregroundStyle(Theme.Colors.textSecondary)
                    Button("Sign in with email") { showEmail = true }
                    Button("Connect GitHub") { showGitHub = true }
                }
            }
            Section("People") {
                if appState.membersLoading { ProgressView("Loading your team…") }
                else if let error = appState.membersError { Text(error); Button("Try again") { Task { await appState.refreshWorkspaceMembers() } } }
                ForEach(appState.workspaceMembers) { member in
                    HStack {
                        VStack(alignment: .leading, spacing: 4) { Text(member.name); Text(member.role).font(.caption).foregroundStyle(Theme.Colors.textSecondary) }
                        Spacer()
                        if member.id == appState.currentUser?.id { Text("You").font(.caption).foregroundStyle(Theme.Colors.textSecondary) }
                    }
                }
            }
            Section("Connections") {
                Button("GitHub") { showGitHub = true }
                if !appState.isGuest { NavigationLink("Connected tools") { ConnectorsView().environmentObject(appState) } }
            }
            Section("Appearance") {
                Picker("Appearance", selection: $appState.appearance) { ForEach(AppAppearance.allCases) { Text($0.label).tag($0) } }
            }
            if appState.isGuest { Section { Button("Reset demo") { confirmReset = true } } }
            else { Section { NavigationLink("Delete account") { DeleteAccountView().environmentObject(appState) } } }
        }.navigationTitle("Workspace").navigationBarTitleDisplayMode(.inline)
            .refreshable { await appState.refreshWorkspaceMembers() }
    }

    private var emailSheet: some View {
        EmailSignInSheet { session, name in
            Task { await appState.activateEmailSession(login: session.login, orgId: session.orgId, name: name, sessionToken: session.token, accountID: session.userID) }
        }.environmentObject(appState).presentationDetents([.large])
    }
    private func group<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        VStack(spacing: 0, content: content).foregroundStyle(Theme.Colors.textPrimary).buttonStyle(.plain)
            .background(Theme.Colors.background, in: RoundedRectangle(cornerRadius: 22))
            .overlay(RoundedRectangle(cornerRadius: 22).stroke(Theme.Colors.border, lineWidth: 1))
    }
    private var separator: some View { Divider().padding(.leading, 52).padding(.trailing, 16) }
    private func row(_ title: LocalizedStringKey, icon: String, value: String? = nil, chevron: Bool = true) -> some View {
        HStack(spacing: 12) {
            Image(systemName: icon).font(.title3).frame(width: 25)
            Text(title).font(.subheadline)
            Spacer(minLength: 8)
            if let value { Text(value).font(.caption).foregroundStyle(Theme.Colors.textSecondary) }
            if chevron { Image(systemName: "chevron.right").font(.caption).foregroundStyle(Theme.Colors.textTertiary) }
        }.padding(16).frame(minHeight: 54)
    }
    private var notificationStatus: String {
        guard PushService.isEnabledInThisBuild, !appState.isGuest else { return String(localized: "Unavailable") }
        return (push.authorization == .authorized || push.authorization == .provisional) ? String(localized: "On") : String(localized: "Off")
    }
    private func openNotifications() {
        guard PushService.isEnabledInThisBuild, !appState.isGuest else { return }
        if push.authorization == .notDetermined { Task { await push.requestAuthorizationIfEarned() } }
        else if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
    }
    private var version: String { Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "1.0" }
}
