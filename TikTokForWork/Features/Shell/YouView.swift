import PhotosUI
import SwiftUI
import UIKit
import UserNotifications

/// Figma Profile: identity, personal controls, then plan and sign out.
struct YouView: View {
    var chat: ChatStore?
    var onCompose: () -> Void = {}
    @EnvironmentObject private var appState: AppState
    @EnvironmentObject private var push: PushService
    @EnvironmentObject private var subscription: SubscriptionService
    @State private var showEmail = false
    @State private var showGitHub = false
    @State private var confirmSignOut = false
    @State private var confirmReset = false
    @State private var editingIdentity = false
    @State private var showDailyReport = false
    @State private var photoItem: PhotosPickerItem?
    @State private var uploadingPhoto = false
    @State private var photoError: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 14) {
                    identityCard
                    if let chat, !appState.isGuest {
                        group {
                            Button { editingIdentity = true } label: { row("Name, username and status", icon: "at", value: statusLine(chat)) }
                            separator
                            // "@hayao": the agents the team writes, and your own.
                            NavigationLink { AgentsView(store: chat).environmentObject(appState) } label: { row("Custom agents", icon: "wand.and.stars") }
                        }
                    }
                    group {
                        NavigationLink { TeamSettingsView().environmentObject(appState) } label: { row("Team", icon: "person.2") }
                        separator
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
                        // Pause notifications, and the hours they may come.
                        NavigationLink { QuietTimeView().environmentObject(appState) } label: { row("Pause and hours", icon: "bell.slash") }.disabled(appState.isGuest)
                        separator
                        // Every device signed in to this account, and signing them out.
                        NavigationLink { SignedInView().environmentObject(appState) } label: { row("Where you’re signed in", icon: "iphone.and.arrow.forward") }.disabled(appState.isGuest)
                        separator
                        // When the morning plan and the evening report are
                        // drafted, and where they are posted.
                        Button { showDailyReport = true } label: { row("Daily report", icon: "square.and.pencil") }.disabled(appState.isGuest)
                        separator
                        NavigationLink { RequestHistoryView().environmentObject(appState) } label: { row("History", icon: "clock.arrow.circlepath") }
                        // The numbers: how long decisions wait, what gets
                        // declined, what the AI got wrong. A guest has no
                        // workspace for them to be about.
                        if !appState.isGuest {
                            NavigationLink { InsightsView().environmentObject(appState) } label: { row("Insights", icon: "chart.bar") }
                        }
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
            .sheet(isPresented: $showDailyReport) { DailyReportSetupView().environmentObject(appState) }
            .sheet(isPresented: $editingIdentity) { if let chat { ChatStatusEditor(store: chat).environmentObject(appState) } }
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
        .modifier(PhotoUpload(item: $photoItem, error: $photoError) { item in await uploadPhoto(item) })
    }

    private func statusLine(_ chat: ChatStore) -> String? {
        if let a = ChatDates.parse(chat.mine?.awayUntil), a > Date() { return String(localized: "Away") }
        guard let s = chat.mine?.status else { return nil }
        let line = [s.emoji, s.text].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " ")
        return line.isEmpty ? nil : line
    }

    private var identityCard: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(spacing: 12) {
                if appState.isGuest {
                    avatar
                } else {
                    // Your photo: what your team sees beside everything you write.
                    PhotosPicker(selection: $photoItem, matching: .images) {
                        avatar
                            .overlay(alignment: .bottomTrailing) {
                                Image(systemName: uploadingPhoto ? "arrow.triangle.2.circlepath" : "camera.fill")
                                    .font(.system(size: 10, weight: .bold)).foregroundStyle(.white)
                                    .frame(width: 20, height: 20).background(Theme.Colors.accent, in: Circle())
                                    .overlay(Circle().stroke(Theme.Colors.background, lineWidth: 2))
                            }
                    }
                    .disabled(uploadingPhoto)
                    .accessibilityLabel("Change your photo")
                }
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

    /// The photo picked, made small and sent; everyone sees it next time
    /// their lists load, and this device at once.
    private func uploadPhoto(_ item: PhotosPickerItem) async {
        uploadingPhoto = true
        defer { uploadingPhoto = false; photoItem = nil }
        guard let data = try? await item.loadTransferable(type: Data.self), let image = UIImage(data: data),
              let jpeg = Self.shrunk(image).jpegData(compressionQuality: 0.85),
              let base = BackendURL.httpBase(from: AppConfig.relayURL), let token = SessionStore.sessionToken else {
            photoError = String(localized: "That photo could not be used.")
            return
        }
        var request = URLRequest(url: base.appendingPathComponent("me/avatar"))
        request.httpMethod = "POST"
        request.timeoutInterval = 30
        request.setValue(token, forHTTPHeaderField: "x-session-token")
        request.setValue("image/jpeg", forHTTPHeaderField: "content-type")
        request.httpBody = jpeg
        guard let (_, response) = try? await URLSession.shared.data(for: request),
              let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
            photoError = String(localized: "Your photo did not upload. Try again.")
            return
        }
        await appState.refreshWorkspaceMembers()
        await chat?.refresh()
    }

    /// At most 512 points on a side: a face, not a poster.
    private static func shrunk(_ image: UIImage) -> UIImage {
        let side = max(image.size.width, image.size.height)
        guard side > 512 else { return image }
        let scale = 512 / side
        let size = CGSize(width: image.size.width * scale, height: image.size.height * scale)
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        return UIGraphicsImageRenderer(size: size, format: format).image { _ in image.draw(in: CGRect(origin: .zero, size: size)) }
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
                if appState.githubService.hasToken { Button("GitHub") { showGitHub = true } }
                if !appState.isGuest { NavigationLink("Connected tools") { ConnectorsView().environmentObject(appState) } }
            }
            Section {
                Link("Privacy Policy", destination: URL(string: "https://app.honmaruai.com/privacy.html")!)
                Link("Support", destination: URL(string: "https://app.honmaruai.com/support.html")!)
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

/// Picking a photo starts its upload; a failure is said once. Its own
/// modifier, so the profile's body stays small enough to type-check.
private struct PhotoUpload: ViewModifier {
    @Binding var item: PhotosPickerItem?
    @Binding var error: String?
    let upload: (PhotosPickerItem) async -> Void

    func body(content: Content) -> some View {
        content
            .onChange(of: item) { _, picked in
                if let picked { Task { await upload(picked) } }
            }
            .alert("Photo", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
                Button("OK", role: .cancel) { error = nil }
            } message: {
                Text(error ?? "")
            }
    }
}
