import SwiftUI

struct AppShell: View {
    @EnvironmentObject private var appState: AppState
    @EnvironmentObject private var push: PushService
    @State private var tab: AppTab = .home
    @State private var showCompose = false
    @State private var showHistory = false
    @State private var captureMode: CaptureMode?
    @State private var hasCaptured = false
    @StateObject private var composer = FeedViewModel()
    @State private var deliveryError: String?
    @State private var sentMessage: String?
    @State private var pendingSentMessage: String?
    @FocusState private var promptFocused: Bool

    var body: some View {
        // Physical stack sizing gives every nested NavigationStack its full
        // usable height. Parent overlays used to cover the detail actions.
        VStack(spacing: 0) {
            Group {
                if tab == .home {
                    FeedView(onProfile: { tab = .you }, onComposeToMember: { id in composer.recipientID = id; showCompose = true })
                } else { YouView { showCompose = true } }
            }.frame(maxWidth: .infinity, maxHeight: .infinity)
            if tab == .home { promptBar }
            AppTabBar(selection: $tab) { promptFocused = false; showCompose = true }
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
            guard !appState.isGuest else { return }
            await appState.refreshWorkspaceMembers()
            while !Task.isCancelled {
                await appState.cardService.syncGitHubStatus(githubService: appState.githubService)
                try? await Task.sleep(for: .seconds(30))
            }
        }
        .onChange(of: appState.currentUser?.teamID) { _, _ in composer.teamChanged() }
        .onChange(of: push.pendingCardID) { _, id in if id != nil { tab = .home } }
        .onReceive(appState.webSocketService.$deliveryError) { if let message = $0 { composer.restoreRejectedDraft(appState: appState); deliveryError = message } }
        .alert("Delivery needs attention", isPresented: Binding(get: { deliveryError != nil }, set: { if !$0 { deliveryError = nil } })) {
            Button("OK") { deliveryError = nil; appState.webSocketService.clearDeliveryError() }
        } message: { Text(deliveryError ?? "") }
        .alert(appState.isGuest ? String(localized: "Demo request created") : String(localized: "Request queued"), isPresented: Binding(get: { sentMessage != nil }, set: { if !$0 { sentMessage = nil } })) {
            Button("View history") { sentMessage = nil; showHistory = true }
            Button("OK", role: .cancel) { sentMessage = nil }
        } message: { Text(sentMessage ?? "") }
    }

    private var promptBar: some View {
        HStack(spacing: 10) {
            Menu {
                Button("New request", systemImage: "square.and.pencil") { promptFocused = false; showCompose = true }
                Button("Speak", systemImage: "mic") { promptFocused = false; captureMode = .dictation }
            } label: {
                Image(systemName: "plus").font(.system(size: 20, weight: .regular)).foregroundStyle(Theme.Colors.textSecondary)
                    .frame(width: 36, height: 36).background(Theme.Colors.surfaceRaised, in: Circle())
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
        .background(Theme.Colors.background, in: Capsule()).overlay(Capsule().stroke(Theme.Colors.border, lineWidth: 1))
        .padding(.horizontal, 20).padding(.top, 8).padding(.bottom, 12)
    }
}
