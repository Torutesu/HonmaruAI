import Combine
import Foundation

@MainActor
final class AppState: ObservableObject {
    @Published var currentUser: User?
    /// Mirrored from the socket so views can observe it. `webSocketService` is a
    /// plain property of this object, so SwiftUI never hears about its own
    /// changes — which is why the connection dot used to be stale as often as
    /// it was wrong.
    @Published private(set) var connectionState: ConnectionState = .offline
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
    let networkMonitor = NetworkMonitor()

    let relayURL = AppConfig.relayURL

    var backendBaseURL: URL? {
        BackendURL.httpBase(from: relayURL)
    }

    init() {
        // didSet does not fire for the initial value, so apply the saved
        // language before the first view renders.
        Bundle.setAppLanguage(language.locale?.identifier)
        cardService.attach(webSocketService: webSocketService)
        webSocketService.$state.assign(to: &$connectionState)
        networkMonitor.onBecameOnline = { [weak self] in
            self?.webSocketService.reconnectIfNeeded()
        }
        networkMonitor.start()
        githubService.onRepositoryChanged = { [weak self] in
            Task { @MainActor in
                await self?.handleRepositoryChanged()
            }
        }
        Task { await bootstrapBackend() }
    }

    func bootstrapBackend() async {
        defer { isBootstrapping = false }

        // Configure RevenueCat before restoring the session, so a restored account is
        // re-identified to the SDK and the entitlement is known before the first screen.
        SubscriptionService.shared.configure()

        guard let backendBaseURL else { return }
        aiService.configure(backendBaseURL: backendBaseURL)
        PushService.shared.configure(backendBaseURL: backendBaseURL)
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
        // The cached feed goes up before the socket is even dialled. Waiting for
        // the relay means a blank screen on a slow network and a permanently
        // blank one with no network at all.
        cardService.adoptOrganization(orgId)
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
        // RevenueCat's app_user_id must match what the Worker asks about.
        if let githubId = SessionStore.githubUserId {
            await SubscriptionService.shared.identify(githubId)
        }
        // The device token is bound to a person on the server. Re-binding it on
        // sign-in is what stops a phone that changed hands from receiving the
        // previous account's decisions.
        PushService.shared.registerExistingToken(sessionToken: SessionStore.sessionToken)
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
        let sessionToken = SessionStore.sessionToken
        Task {
            // Drop back to an anonymous RevenueCat id so the next account on this
            // device does not inherit this person's entitlement.
            await SubscriptionService.shared.signOut()
            // Unregister while the token is still valid — afterwards the server
            // has no way to know which device to forget, and this phone keeps
            // buzzing about someone else's decisions.
            await PushService.shared.unregister(sessionToken: sessionToken)
        }
        PushService.shared.setBadge(0)
        webSocketService.disconnect()
        githubService.disconnect()
        cardService.reset()
        SessionStore.clear()
        UserDefaults.standard.removeObject(forKey: FirstRunFlags.promptedGitHubConnect)
        isGuest = false
        isAuthenticated = false
        currentUser = nil
    }

    enum AccountError: LocalizedError {
        case notSignedIn
        case server(String)

        var errorDescription: String? {
            switch self {
            case .notSignedIn: String(localized: "Sign in before deleting your account.")
            case .server(let message): message
            }
        }
    }

    /// Erase the account on the server, then leave. Signing out locally first
    /// would throw away the session token the request needs, and signing out
    /// only locally would leave the account alive on a server the user believes
    /// they have left.
    func deleteAccount() async throws {
        guard let base = backendBaseURL, let token = SessionStore.sessionToken else {
            throw AccountError.notSignedIn
        }
        var request = URLRequest(url: base.appending(path: "account"))
        request.httpMethod = "DELETE"
        request.timeoutInterval = 20
        request.setValue(token, forHTTPHeaderField: "x-session-token")

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw AccountError.server(String(localized: "No response from the server."))
        }
        guard (200...299).contains(http.statusCode) else {
            let message = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["message"] as? String
            throw AccountError.server(message ?? String(localized: "Could not delete your account."))
        }
        signOut()
    }

    /// Switching repositories switches organizations, so the cards on screen
    /// belong to the old one and have to go. They are dropped locally only —
    /// they are still the other org's decisions, and deleting them there would
    /// take the rest of that team's pending work with them.
    func handleRepositoryChanged() async {
        cardService.reset()
    }
}
