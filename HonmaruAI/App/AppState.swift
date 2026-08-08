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
        guard SessionStore.hasSavedGitHubSession else {
            githubService.restorePartialCredentials()
            return
        }

        guard githubService.restoreSavedSession() else {
            SessionStore.clear()
            return
        }

        do {
            try await githubService.validateSavedSession()
            let userID = SessionStore.currentUserID ?? AppConfig.defaultUser.id
            let user = DemoData.user(for: userID) ?? AppConfig.defaultUser
            await activateSession(as: user)
        } catch {
            githubService.disconnect()
        }
    }

    func activateSession(as user: User = AppConfig.defaultUser) async {
        SessionStore.currentUserID = user.id

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
