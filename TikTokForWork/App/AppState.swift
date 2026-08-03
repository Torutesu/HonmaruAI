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
    let subscriptionService = SubscriptionService()
    let routingQuota = RoutingQuota()

    let relayURL = AppConfig.relayURL

    var backendBaseURL: URL? {
        BackendURL.httpBase(from: relayURL)
    }

    init() {
        // Configure RevenueCat before anything renders so `isPro` is known on first frame.
        // A saved session identifies the app user right away; otherwise the SDK starts
        // anonymous and `activateSession(as:)` aliases it once the user signs in.
        subscriptionService.configure(appUserID: SessionStore.currentUserID)
        if let userID = SessionStore.currentUserID {
            routingQuota.bind(userID: userID)
        }

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
        await subscriptionService.identify(userID: user.id)
        routingQuota.bind(userID: user.id)

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
        // Each demo persona is its own RevenueCat app user, so entitlements don't leak
        // between them when switching accounts on the same device.
        await subscriptionService.identify(userID: user.id)
        routingQuota.bind(userID: user.id)
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
            await subscriptionService.signOut()
        }
        routingQuota.reset()
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
