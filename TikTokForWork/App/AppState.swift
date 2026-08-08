import Foundation

@MainActor
final class AppState: ObservableObject {
    @Published var currentUser: User?
    @Published var isAuthenticated = false
    @Published private(set) var isBootstrapping = true

    let cardService = DecisionCardService()
    let githubService = GitHubService()
    let webSocketService = WebSocketService()
    let aiService = AIService()
    /// Classic's channels and messages. Local, so the comparison surface keeps
    /// working when the relay does not.
    let chatStore = ChatStore()

    let relayURL = AppConfig.relayURL

    var backendBaseURL: URL? {
        BackendURL.httpBase(from: relayURL)
    }

    init() {
        cardService.attach(webSocketService: webSocketService)
        githubService.onRepositoryChanged = { [weak self] in
            Task { @MainActor in
                await self?.handleRepositoryChanged()
            }
        }
        Task { await bootstrapBackend() }
    }

    func bootstrapBackend() async {
        defer { isBootstrapping = false }

        guard let backendBaseURL else { return }
        await aiService.configure(backendBaseURL: backendBaseURL)
        await restoreSessionIfNeeded()
    }

    func restoreSessionIfNeeded() async {
        // GitHub is optional: a saved persona alone is enough to return to the feed.
        guard SessionStore.hasSavedGitHubSession else {
            githubService.restorePartialCredentials()
            if let userID = SessionStore.currentUserID,
               let user = DemoData.user(for: userID) {
                await activateSession(as: user)
            }
            return
        }

        let userID = SessionStore.currentUserID ?? AppConfig.defaultUser.id
        let user = DemoData.user(for: userID) ?? AppConfig.defaultUser

        if githubService.restoreSavedSession() {
            do {
                try await githubService.validateSavedSession()
            } catch {
                githubService.disconnect()
            }
        }

        await activateSession(as: user)
    }

    func activateSession(as user: User = AppConfig.defaultUser) async {
        SessionStore.currentUserID = user.id
        cardService.setActiveUser(user.id)

        do {
            try await webSocketService.connect(urlString: relayURL, userId: user.id)
        } catch {
            cardService.bootstrap(for: user)
        }
        currentUser = user
        isAuthenticated = true
    }

    func switchUser(to user: User) async {
        SessionStore.currentUserID = user.id
        cardService.setActiveUser(user.id)
        webSocketService.disconnect()
        do {
            try await webSocketService.connect(urlString: relayURL, userId: user.id)
        } catch {
            cardService.bootstrap(for: user)
        }
        currentUser = user
    }

    func signOut() {
        Task {
            await webSocketService.publishClearStore()
        }
        webSocketService.disconnect()
        githubService.disconnect()
        cardService.reset()
        SessionStore.clear()
        DecisionCardService.resetSeedMarker()
        UserDefaults.standard.removeObject(forKey: FirstRunFlags.promptedGitHubConnect)
        isAuthenticated = false
        currentUser = nil
    }

    func handleRepositoryChanged() async {
        cardService.reset()
        if webSocketService.isConnected {
            await webSocketService.publishClearStore()
        }
    }
}
