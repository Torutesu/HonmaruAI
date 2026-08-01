import Foundation

@MainActor
final class AppState: ObservableObject {
    @Published var currentUser: User?
    @Published var isAuthenticated = false
    @Published private(set) var isBootstrapping = true

    let cardService = DecisionCardService()
    let channelService = ChannelService()
    let orgService = OrganizationService()
    let pushService = PushNotificationService()
    let githubService = GitHubService()
    let webSocketService = WebSocketService()
    let aiService = AIService()

    @Published private(set) var relayURL: String
    @Published private(set) var relayToken: String?

    var backendBaseURL: URL? {
        BackendURL.httpBase(from: relayURL)
    }

    init() {
        relayURL = SessionStore.relayURL ?? AppConfig.defaultRelayURL
        relayToken = SessionStore.relayToken
        cardService.attach(webSocketService: webSocketService)
        channelService.attach(webSocketService: webSocketService)
        orgService.attach(webSocketService: webSocketService)
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
        await aiService.configure(backendBaseURL: backendBaseURL, relayToken: relayToken)
        await orgService.configure(backendBaseURL: backendBaseURL, relayToken: relayToken)
        pushService.configure(backendBaseURL: backendBaseURL, relayToken: relayToken)
        cardService.configureRelay(baseURL: backendBaseURL, token: relayToken)
        await restoreSessionIfNeeded()
    }

    func updateRelaySettings(url: String, token: String) async {
        let trimmedURL = url.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedToken = token.trimmingCharacters(in: .whitespacesAndNewlines)

        relayURL = trimmedURL.isEmpty ? AppConfig.defaultRelayURL : trimmedURL
        relayToken = trimmedToken.isEmpty ? nil : trimmedToken
        SessionStore.relayURL = relayURL == AppConfig.defaultRelayURL ? nil : relayURL
        SessionStore.relayToken = relayToken

        if let backendBaseURL {
            await aiService.configure(backendBaseURL: backendBaseURL, relayToken: relayToken)
            await orgService.configure(backendBaseURL: backendBaseURL, relayToken: relayToken)
            pushService.configure(backendBaseURL: backendBaseURL, relayToken: relayToken)
            cardService.configureRelay(baseURL: backendBaseURL, token: relayToken)
        }

        if isAuthenticated, let user = currentUser {
            webSocketService.disconnect(intentional: true)
            try? await webSocketService.connect(urlString: relayURL, userId: user.id, token: relayToken)
        }
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

    func activateSession(as user: User? = nil) async {
        // No explicit user: prefer the org member whose GitHub account just
        // signed in, then the first member of the roster.
        let resolved = user
            ?? orgService.userMatching(githubUsername: githubService.connection?.username)
            ?? orgService.users.first
            ?? AppConfig.defaultUser
        SessionStore.currentUserID = resolved.id

        do {
            try await webSocketService.connect(urlString: relayURL, userId: resolved.id, token: relayToken)
        } catch {
            cardService.bootstrap(for: resolved)
        }
        currentUser = resolved
        isAuthenticated = true
        pushService.activate(for: resolved.id)
    }

    func switchUser(to user: User) async {
        SessionStore.currentUserID = user.id
        webSocketService.disconnect()
        do {
            try await webSocketService.connect(urlString: relayURL, userId: user.id, token: relayToken)
        } catch {
            cardService.bootstrap(for: user)
        }
        currentUser = user
        pushService.activate(for: user.id)
    }

    func signOut() {
        Task {
            await webSocketService.publishClearStore()
        }
        webSocketService.disconnect()
        githubService.disconnect()
        cardService.reset()
        channelService.reset()
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
