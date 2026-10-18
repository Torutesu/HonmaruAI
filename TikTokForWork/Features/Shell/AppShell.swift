import SwiftUI

struct AppShell: View {
    @EnvironmentObject private var appState: AppState
    @EnvironmentObject private var push: PushService
    @State private var tab: AppTab = .home
    /// Home as cards, or as Slack's list of channels.
    @AppStorage("home.list") private var homeList = false
    @State private var showCompose = false
    @State private var showHistory = false
    @State private var captureMode: CaptureMode?
    @State private var hasCaptured = false
    @StateObject private var composer = FeedViewModel()
    @StateObject private var chat = ChatStore()
    @State private var deliveryError: String?
    @State private var sentMessage: String?
    @State private var pendingSentMessage: String?
    /// The daily report, offered once after sign-in to someone without one.
    @State private var offerDailyReport = false
    @FocusState private var promptFocused: Bool

    var body: some View {
        // Physical stack sizing gives every nested NavigationStack its full
        // usable height. Parent overlays used to cover the detail actions.
        VStack(spacing: 0) {
            Group {
                switch tab {
                case .home:
                    if homeList {
                        ChatHomeView(store: chat, mode: .home) { search in
                            AnyView(HomeHeader(service: appState.cardService, list: $homeList, onSearch: search, onProfile: { tab = .you }))
                        }
                    } else {
                        FeedView(list: $homeList, onProfile: { tab = .you })
                    }
                case .dms: ChatHomeView(store: chat, mode: .dms)
                case .activity: ChatHomeView(store: chat, mode: .activity)
                case .you: YouView(chat: chat) { showCompose = true }
                }
            }.frame(maxWidth: .infinity, maxHeight: .infinity)
            if tab == .home && !homeList { promptBar }
            AppTabBar(selection: $tab, dmBadge: chat.unreadDMs, activityBadge: chat.unreadInbox) { promptFocused = false; showCompose = true }
        }
        .background(Theme.Colors.surface)
        .tint(Theme.Colors.accent)
        .sheet(isPresented: $showCompose, onDismiss: {
            if let message = pendingSentMessage { sentMessage = message; pendingSentMessage = nil }
        }) {
            RequestComposerView(model: composer) { _ in
                showCompose = false
                pendingSentMessage = appState.isGuest ? String(localized: "Created in the demo. You can follow the request in History.") : String(localized: "Request queued. You can follow delivery and the outcome in History.")
            }
        }
        .sheet(isPresented: $offerDailyReport) {
            DailyReportSetupView(firstRun: true).environmentObject(appState)
        }
        .sheet(isPresented: $showHistory) {
            NavigationStack { RequestHistoryView().toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { showHistory = false } } } }
        }
        .fullScreenCover(item: $captureMode, onDismiss: {
            if hasCaptured { hasCaptured = false; showCompose = true }
        }) { mode in
            CaptureView(mode: mode) { text, video in composer.useCapture(text: text, video: video); hasCaptured = true }
        }
        .task(id: appState.activeSessionID) {
            composer.bind(to: appState)
            chat.bind(appState)
            guard !appState.isGuest else { return }
            await chat.refresh()
            await chat.loadInbox()
            await appState.refreshWorkspaceMembers()
            await offerDailyReportIfNeeded()
            while !Task.isCancelled {
                await appState.cardService.syncGitHubStatus(githubService: appState.githubService)
                try? await Task.sleep(for: .seconds(30))
            }
        }
        .onChange(of: appState.currentUser?.teamID) { _, _ in composer.teamChanged(appState: appState) }
        .onChange(of: push.pendingCardID) { _, id in if id != nil { homeList = false; tab = .home } }
        // A chat notification: its workspace, then its conversation. Also on
        // appearing, for the tap that launched the app.
        .onChange(of: push.pendingMessage) { _, _ in Task { await openTappedMessage() } }
        .onAppear { Task { await openTappedMessage() } }
        .onReceive(appState.webSocketService.$deliveryError) { if let message = $0 { composer.restoreRejectedDraft(appState: appState); deliveryError = message } }
        .alert("Delivery needs attention", isPresented: Binding(get: { deliveryError != nil }, set: { if !$0 { deliveryError = nil } })) {
            Button("OK") { deliveryError = nil; appState.webSocketService.clearDeliveryError() }
        } message: { Text(deliveryError ?? "") }
        .alert(appState.isGuest ? String(localized: "Demo request created") : String(localized: "Request queued"), isPresented: Binding(get: { sentMessage != nil }, set: { if !$0 { sentMessage = nil } })) {
            Button("View history") { sentMessage = nil; showHistory = true }
            Button("OK", role: .cancel) { sentMessage = nil }
        } message: { Text(sentMessage ?? "") }
    }

    @MainActor private func openTappedMessage() async {
        guard let target = push.pendingMessage, !appState.isGuest else { return }
        push.pendingMessage = nil
        if let org = target.orgId, org != appState.currentUser?.teamID {
            // Not a workspace this account is in any more: nothing to open.
            guard (try? await appState.switchToJoinedTeam(org)) != nil, appState.currentUser?.teamID == org else { return }
        }
        // A tap that launched the app can come before the chat is bound.
        chat.bind(appState)
        tab = .activity
        chat.pendingOpen = target
    }

    /// The phone's part of onboarding: once per person and workspace on this
    /// phone, someone with no daily report yet is asked when theirs should be
    /// drafted. Asked once — "Later" is an answer, and You has it after that.
    @MainActor private func offerDailyReportIfNeeded() async {
        guard !appState.isGuest, let me = appState.currentUser?.id,
              let org = appState.currentUser?.teamID, !org.isEmpty,
              let base = appState.backendBaseURL else { return }
        let key = "dailyReportOffered:\(org):\(me)"
        guard !UserDefaults.standard.bool(forKey: key) else { return }
        guard let routines = try? await DailyReportService.routines(orgId: org, backendBaseURL: base) else { return }
        UserDefaults.standard.set(true, forKey: key)
        if !routines.contains(where: { DailyReportService.Part(rawValue: $0.kind) != nil }) { offerDailyReport = true }
    }

    private var promptBar: some View {
        HStack(spacing: 10) {
            Menu {
                Button("New request", systemImage: "square.and.pencil") { promptFocused = false; showCompose = true }
                Button("Speak", systemImage: "mic") { promptFocused = false; captureMode = .dictation }
            } label: {
                Image(systemName: "plus").font(.system(size: 20, weight: .regular)).foregroundStyle(Theme.Colors.textSecondary)
                    .frame(width: 36, height: 36).glassCircle()
            }.accessibilityLabel("Add to request")
            TextField("Ask anything…", text: $composer.sourceText, axis: .vertical)
                .font(.system(size: 15)).lineLimit(1...3).focused($promptFocused).submitLabel(.done)
                .onSubmit { promptFocused = false; showCompose = true }
            Button { promptFocused = false; captureMode = .dictation } label: {
                Image(systemName: "mic").font(.system(size: 21)).foregroundStyle(Theme.Colors.textSecondary).frame(width: 28, height: 40)
            }.accessibilityLabel("Dictate")
            Button { promptFocused = false; showCompose = true } label: {
                Image(systemName: "paperplane").font(.system(size: 19)).foregroundStyle(Theme.Colors.ctaText)
                    .frame(width: 36, height: 36).background(Theme.Colors.ctaFill, in: Circle())
            }.accessibilityLabel("Review request").disabled(composer.sourceText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
        .buttonStyle(.plain)
        .padding(5).padding(.trailing, 1)
        .glassCapsule(interactive: true)
        .padding(.horizontal, 20).padding(.top, 8).padding(.bottom, 6)
    }
}
