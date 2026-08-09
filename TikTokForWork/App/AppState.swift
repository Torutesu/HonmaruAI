import Foundation

@MainActor
final class AppState: ObservableObject {
    @Published var currentUser: User?
    @Published var isAuthenticated = false
    @Published private(set) var isBootstrapping = true
    @Published var organization = OrganizationGraph(nodes: [], edges: [])
    @Published var language: AppLanguage = {
        AppLanguage(rawValue: UserDefaults.standard.string(forKey: "appLanguage") ?? "system") ?? .system
    }() {
        didSet { applyLanguage() }
    }

    @Published var appearance: AppAppearance = {
        AppAppearance(rawValue: UserDefaults.standard.string(forKey: "appAppearance") ?? "system") ?? .system
    }() {
        didSet { UserDefaults.standard.set(appearance.rawValue, forKey: "appAppearance") }
    }

    private func applyLanguage() {
        UserDefaults.standard.set(language.rawValue, forKey: "appLanguage")
        if let code = language.locale?.identifier {
            UserDefaults.standard.set([code], forKey: "AppleLanguages")
        } else {
            UserDefaults.standard.removeObject(forKey: "AppleLanguages")
        }
        // Point Bundle.main at the chosen .lproj so the string catalog switches
        // live — SwiftUI's \.locale does not re-resolve catalog lookups.
        Bundle.setAppLanguage(language.locale?.identifier)
    }

    /// The reader language to send to the AI for card generation.
    var readerLanguageCode: String { language.readerLanguageCode }

    let cardService = DecisionCardService()
    let githubService = GitHubService()
    let webSocketService = WebSocketService()
    let aiService = AIService()

    let relayURL = AppConfig.relayURL

    var backendBaseURL: URL? {
        BackendURL.httpBase(from: relayURL)
    }

    init() {
        // didSet does not fire for the initial value, so apply the saved
        // language before the first view renders.
        Bundle.setAppLanguage(language.locale?.identifier)
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
        aiService.configure(backendBaseURL: backendBaseURL)
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

    /// What this user told their AI about how they work. Kept locally so it can
    /// ride along with every routing request, and mirrored to the relay so it
    /// survives a reinstall.
    @Published var userContext: String = UserDefaults.standard.string(forKey: "userContext") ?? "" {
        didSet { UserDefaults.standard.set(userContext, forKey: "userContext") }
    }

    func publishUserContext() async {
        await webSocketService.publishContext(userContext)
    }

    /// Whether the current session is a look-around guest (no GitHub sign-in).
    @Published private(set) var isGuest = false

    /// Enter without signing in, to look around. There is no org and no relay
    /// connection — the feed is empty and AI routing has no teammates — but the
    /// UI is fully explorable, and the user can sign in later from the account
    /// screen to get the real thing.
    func activateGuestSession() {
        isGuest = true
        organization = OrganizationGraph(nodes: [], edges: [])
        let guest = User(id: "guest", name: "Guest", role: "Guest", teamID: nil, githubUsername: nil)
        cardService.setActiveUser(guest.id)
        currentUser = guest
        isAuthenticated = true
    }

    func activateGitHubSession(connection: GitHubConnection) async {
        isGuest = false
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
        // Load the org in the background so entry never blocks on reachability.
        Task { await loadOrganization(owner: orgOwner(orgId), repo: orgRepo(orgId)) }
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
        isGuest = false
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
