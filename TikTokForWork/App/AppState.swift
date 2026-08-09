import Foundation

@MainActor
final class AppState: ObservableObject {
    @Published var currentUser: User?
    @Published var isAuthenticated = false
    @Published private(set) var isBootstrapping = true
    @Published var organization = OrganizationGraph(nodes: [], edges: [])

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
        guard SessionStore.hasSavedGitHubSession,
              githubService.restoreSavedSession(),
              let connection = githubService.connection else {
            return
        }
        do {
            try await githubService.validateSavedSession()
        } catch {
            githubService.disconnect()
            SessionStore.clear()
            return
        }
        await activateGitHubSession(connection: connection)
    }

    static func user(from connection: GitHubConnection) -> User {
        User(
            id: connection.username,
            name: connection.username,
            role: "Member",
            teamID: connection.repository,
            githubUsername: connection.username
        )
    }

    func activateGitHubSession(connection: GitHubConnection) async {
        let user = AppState.user(from: connection)
        SessionStore.currentUserID = user.id
        cardService.setActiveUser(user.id)
        let orgId = connection.repository            // "owner/repo"
        do {
            try await webSocketService.connect(
                urlString: relayURL,
                userId: user.id,
                orgId: orgId,
                sessionToken: SessionStore.sessionToken
            )
        } catch {
            // Relay unreachable: still let the user in; the feed will be empty.
        }
        currentUser = user
        isAuthenticated = true
        await loadOrganization(owner: orgOwner(orgId), repo: orgRepo(orgId))
    }

    private func orgOwner(_ full: String) -> String { full.split(separator: "/").first.map(String.init) ?? "" }
    private func orgRepo(_ full: String) -> String { full.split(separator: "/").dropFirst().first.map(String.init) ?? "" }

    func loadOrganization(owner: String, repo: String) async {
        guard !owner.isEmpty, !repo.isEmpty,
              let base = backendBaseURL,
              let token = SessionStore.sessionToken,
              let url = URL(string: "orgs/\(owner)/\(repo)/graph", relativeTo: base) else { return }
        var request = URLRequest(url: url)
        request.setValue(token, forHTTPHeaderField: "x-session-token")
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else { return }
            organization = try JSONDecoder().decode(OrganizationGraph.self, from: data)
        } catch {
        }
    }

    func signOut() {
        Task {
            await webSocketService.publishClearStore()
        }
        webSocketService.disconnect()
        githubService.disconnect()
        cardService.reset()
        SessionStore.clear()
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
