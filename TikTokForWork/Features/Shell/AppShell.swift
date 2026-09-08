import SwiftUI

struct AppShell: View {
    @EnvironmentObject private var appState: AppState
    @EnvironmentObject private var push: PushService
    @State private var tab: AppTab = .inbox
    @State private var showCompose = false
    @StateObject private var composer = FeedViewModel()
    @State private var deliveryError: String?
    @State private var sentMessage: String?
    @State private var pendingSentMessage: String?
    @State private var sentRevision = 0

    var body: some View {
        TabView(selection: $tab) {
            FeedView(queue: .inbox) { showCompose = true }
                .tabItem { Label("Inbox", systemImage: "tray") }.badge(appState.pendingCount).tag(AppTab.inbox)
            FeedView(queue: .sent) { showCompose = true }.id(sentRevision)
                .tabItem { Label("Sent", systemImage: "paperplane") }.tag(AppTab.sent)
            FeedView(queue: .completed) { showCompose = true }
                .tabItem { Label("Completed", systemImage: "checkmark.circle") }.tag(AppTab.completed)
            YouView { showCompose = true }
                .tabItem { Label("Workspace", systemImage: "square.grid.2x2") }.tag(AppTab.workspace)
        }
        .tint(Theme.Colors.accent)
        .sheet(isPresented: $showCompose, onDismiss: {
            if let message = pendingSentMessage { sentMessage = message; pendingSentMessage = nil }
        }) {
            RequestComposerView(model: composer) { card in
                showCompose = false
                tab = .sent
                sentRevision += 1
                pendingSentMessage = appState.isGuest ? String(localized: "Created in the demo. Open Sent to follow the request.") : String(localized: "Request queued. Sent shows when your workspace receives it.")
            }
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
        .onChange(of: push.pendingCardID) { _, id in if id != nil { tab = .inbox } }
        .onReceive(appState.webSocketService.$deliveryError) { if let message = $0 { composer.restoreRejectedDraft(appState: appState); deliveryError = message } }
        .alert("Delivery needs attention", isPresented: Binding(get: { deliveryError != nil }, set: { if !$0 { deliveryError = nil } })) {
            Button("OK") { deliveryError = nil; appState.webSocketService.clearDeliveryError() }
        } message: { Text(deliveryError ?? "") }
        .alert(appState.isGuest ? String(localized: "Demo request created") : String(localized: "Request queued"), isPresented: Binding(get: { sentMessage != nil }, set: { if !$0 { sentMessage = nil } })) {
            Button("OK") { sentMessage = nil }
        } message: { Text(sentMessage ?? "") }
    }
}
