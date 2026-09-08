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
    /// Mirrored for the same reason as `connectionState`: `cardService` is a
    /// plain property, so SwiftUI never hears it change.
    @Published private(set) var pendingCount = 0
    @Published var isAuthenticated = false
    @Published private(set) var isBootstrapping = true
    @Published var organization = OrganizationGraph(nodes: [], edges: [])
    @Published private(set) var workspaceMembers: [WorkspaceMember] = []
    @Published private(set) var membersLoading = false
    @Published private(set) var membersError: String?

    var workspaceDisplayName: String {
        isGuest ? String(localized: "Demo workspace") : (currentUser?.teamID ?? String(localized: "Workspace"))
    }

    func refreshWorkspaceMembers() async {
        let generation = sessionGeneration
        if isGuest { workspaceMembers = DemoWorkspace.members; return }
        guard let orgID = currentUser?.teamID, !orgID.isEmpty, let base = backendBaseURL,
              let token = SessionStore.sessionToken else { return }
        membersLoading = true
        do {
            let members = try await WorkspaceMemberService.fetch(orgID: orgID, baseURL: base, sessionToken: token)
            guard generation == sessionGeneration, !isGuest, currentUser?.teamID == orgID,
                  SessionStore.sessionToken == token else { return }
            workspaceMembers = members
            if githubService.connection == nil {
                organization = OrganizationGraph(nodes: members.map { OrgNode(id: $0.id, kind: .person, label: "\($0.name) · \($0.role)") }, edges: [])
            }
            membersError = nil
        } catch {
            guard generation == sessionGeneration, !isGuest, currentUser?.teamID == orgID,
                  SessionStore.sessionToken == token else { return }
            membersError = String(localized: "Could not load teammates. Try again.")
        }
        membersLoading = false
    }

    func resetDemoWorkspace() {
        guard isGuest else { return }
        workspaceMembers = DemoWorkspace.members
        organization = DemoWorkspace.organization
        currentUser = User(id: DemoWorkspace.userID, name: String(localized: "You"), role: String(localized: "Demo member"), teamID: DemoWorkspace.id, githubUsername: nil)
        cardService.activateDemo(cardsByUser: DemoWorkspace.cards(), userID: DemoWorkspace.userID)
    }
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
        // The server composes every notification, so it has to know too.
        Task { await syncLanguageToBackend() }
    }

    /// Mirror the reader language to the Worker, which writes every
    /// notification — push, web push, email — in it. A guest has no session
    /// and nothing to mirror to.
    func syncLanguageToBackend() async {
        guard isAuthenticated, !isGuest, let base = backendBaseURL else { return }
        await ProfileService.setLocale(readerLanguageCode, backendBaseURL: base)
    }

    /// The reader language to send to the AI for card generation.
    var readerLanguageCode: String { language.readerLanguageCode }

    let cardService = DecisionCardService()
    let githubService = GitHubService()
    let webSocketService = WebSocketService()
    let aiService = AIService()
    let networkMonitor = NetworkMonitor()

    let relayURL = AppConfig.relayURL
    private var sessionGeneration = UUID()
    private let accountSession: URLSession
    private let accountToken: () -> String?
    var activeSessionID: UUID { sessionGeneration }

    var backendBaseURL: URL? {
        BackendURL.httpBase(from: relayURL)
    }

    init(startServices: Bool = true, accountSession: URLSession = .shared, accountToken: @escaping () -> String? = { SessionStore.sessionToken }) {
        self.accountSession = accountSession
        self.accountToken = accountToken
        // didSet does not fire for the initial value, so apply the saved
        // language before the first view renders.
        Bundle.setAppLanguage(language.locale?.identifier)
        cardService.attach(webSocketService: webSocketService)
        webSocketService.$state.assign(to: &$connectionState)
        cardService.$pendingCount.assign(to: &$pendingCount)
        networkMonitor.onBecameOnline = { [weak self] in
            self?.webSocketService.reconnectIfNeeded()
        }
        if startServices { networkMonitor.start() }
        githubService.onRepositoryChanged = { [weak self] in
            Task { @MainActor in
                await self?.handleRepositoryChanged()
            }
        }
        if startServices { Task { await bootstrapBackend() } }
        else { isBootstrapping = false }
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
        guard !isGuest else { return }
        let generation = sessionGeneration
        if SessionStore.hasSavedEmailSession, let login = SessionStore.currentUserID {
            await activateEmailSession(login: login, orgId: SessionStore.orgId ?? "", name: nil, accountID: SessionStore.accountID)
            return
        }
        guard SessionStore.hasSavedGitHubSession,
              githubService.restoreSavedSession() else {
            return
        }
        do {
            try await githubService.validateSavedSession()
        } catch {
            guard generation == sessionGeneration else { return }
            if (error as? GitHubServiceError)?.invalidatesSavedSession == true {
                githubService.disconnect()
                SessionStore.clear()
                return
            }
            // The saved identity and cached feed remain usable during an
            // outage. The relay will validate membership again on reconnect.
        }
        guard generation == sessionGeneration else { return }
        guard let connection = githubService.connection else { return }
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

    /// An isolated sample workspace. Demo requests and actions remain in memory;
    /// no relay or connected external tool receives them.
    func activateGuestSession() {
        sessionGeneration = UUID()
        webSocketService.disconnect()
        webSocketService.clearPendingEvents()
        cardService.reset()
        isGuest = true
        organization = DemoWorkspace.organization
        workspaceMembers = DemoWorkspace.members
        membersError = nil
        membersLoading = false
        let guest = User(id: DemoWorkspace.userID, name: String(localized: "You"), role: String(localized: "Demo member"), teamID: DemoWorkspace.id, githubUsername: nil)
        cardService.activateDemo(cardsByUser: DemoWorkspace.cards(), userID: guest.id)
        currentUser = guest
        isAuthenticated = true
    }

    /// A relay login as something to put on a screen: "u:mai@honmaru.jp"
    /// becomes "mai". Only a fallback — the name the person typed wins.
    nonisolated static func readableLogin(_ login: String) -> String {
        var value = login
        for prefix in ["u:", "email:"] where value.hasPrefix(prefix) {
            value = String(value.dropFirst(prefix.count))
        }
        return value.split(separator: "@").first.map(String.init) ?? value
    }

    /// Signed in with an email code. Same shape as a GitHub session minus the
    /// repository: the org comes from the server, and the person's teammates
    /// are whoever else is in it rather than a repo's collaborators.
    func activateEmailSession(login: String, orgId: String, name: String?, sessionToken: String? = nil, accountID: String? = nil) async {
        guard let token = sessionToken ?? SessionStore.sessionToken, !token.isEmpty, !login.isEmpty else { return }
        sessionGeneration = UUID()
        let generation = sessionGeneration
        webSocketService.disconnect()
        if currentUser?.id != login { webSocketService.clearPendingEvents() }
        // The code verification just issued this token. Clearing the old
        // GitHub identity must preserve it, while cancelling old OAuth work.
        githubService.disconnect(clearStoredSession: false)
        SessionStore.sessionToken = token
        SessionStore.currentUserID = login
        SessionStore.orgId = orgId
        SessionStore.accountID = accountID
        isGuest = false
        organization = OrganizationGraph(nodes: [], edges: [])
        workspaceMembers = []
        membersLoading = false
        membersError = nil
        let display = name?.trimmingCharacters(in: .whitespacesAndNewlines)
        let user = User(id: login, name: display.flatMap { $0.isEmpty ? nil : $0 } ?? AppState.readableLogin(login), role: "Member", teamID: orgId.isEmpty ? nil : orgId, githubUsername: nil)
        currentUser = user
        isAuthenticated = true
        if orgId.isEmpty {
            cardService.reset()
            cardService.setActiveUser(user.id)
            membersError = String(localized: "This account has no workspace. Join a team to send requests.")
        } else {
            cardService.setActiveUser(user.id)
            cardService.adoptOrganization(orgId)
            do {
                try await webSocketService.connect(urlString: relayURL, userId: user.id, orgId: orgId, sessionToken: token)
            } catch { }
        }
        guard generation == sessionGeneration else { return }
        if let accountID { await SubscriptionService.shared.identify(accountID) }
        guard generation == sessionGeneration else { return }
        PushService.shared.registerExistingToken(sessionToken: token)
        Task { await refreshWorkspaceMembers() }
        Task { await syncLanguageToBackend() }
    }

    func activateGitHubSession(connection: GitHubConnection) async {
        sessionGeneration = UUID()
        let generation = sessionGeneration
        isGuest = false
        membersLoading = false
        workspaceMembers = []
        membersError = nil
        let user = AppState.user(from: connection)
        if currentUser?.teamID != user.teamID {
            organization = OrganizationGraph(nodes: [], edges: [])
        }
        currentUser = user
        isAuthenticated = true
        SessionStore.currentUserID = user.id
        SessionStore.orgId = connection.repository
        SessionStore.accountID = SessionStore.githubUserId
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
        guard generation == sessionGeneration else { return }
        // RevenueCat's app_user_id must match what the Worker asks about.
        if let githubId = SessionStore.githubUserId {
            await SubscriptionService.shared.identify(githubId)
        }
        guard generation == sessionGeneration else { return }
        // The device token is bound to a person on the server. Re-binding it on
        // sign-in is what stops a phone that changed hands from receiving the
        // previous account's decisions.
        PushService.shared.registerExistingToken(sessionToken: SessionStore.sessionToken)
        // Load the org in the background so entry never blocks on reachability.
        Task { await loadOrganization(owner: orgOwner(orgId), repo: orgRepo(orgId)) }
        Task { await refreshWorkspaceMembers() }
        // And the language this person reads, so the first notification is
        // already in it — the server seeded one from the device on sign-in,
        // but the in-app toggle is the choice that counts.
        Task { await syncLanguageToBackend() }
    }

    private func orgOwner(_ full: String) -> String { full.split(separator: "/").first.map(String.init) ?? "" }
    private func orgRepo(_ full: String) -> String { full.split(separator: "/").dropFirst().first.map(String.init) ?? "" }

    func loadOrganization(owner: String, repo: String) async {
        let generation = sessionGeneration
        guard !owner.isEmpty, !repo.isEmpty,
              let base = backendBaseURL,
              let token = SessionStore.sessionToken,
              let url = URL(string: "orgs/\(owner)/\(repo)/graph", relativeTo: base) else { return }
        var request = URLRequest(url: url)
        request.setValue(token, forHTTPHeaderField: "x-session-token")
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else { return }
            guard generation == sessionGeneration, isAuthenticated, !isGuest,
                  currentUser?.teamID == "\(owner)/\(repo)",
                  SessionStore.sessionToken == token else { return }
            organization = try JSONDecoder().decode(OrganizationGraph.self, from: data)
        } catch {
        }
    }

    func signOut() {
        sessionGeneration = UUID()
        let generation = sessionGeneration
        let sessionToken = SessionStore.sessionToken
        Task {
            // Drop back to an anonymous RevenueCat id so the next account on this
            // device does not inherit this person's entitlement.
            if sessionGeneration == generation { await SubscriptionService.shared.signOut() }
            // Unregister while the token is still valid — afterwards the server
            // has no way to know which device to forget, and this phone keeps
            // buzzing about someone else's decisions.
            await PushService.shared.unregister(sessionToken: sessionToken)
        }
        PushService.shared.setBadge(0)
        webSocketService.disconnect()
        webSocketService.clearPendingEvents()
        githubService.disconnect()
        cardService.reset()
        SessionStore.clear()
        UserDefaults.standard.removeObject(forKey: FirstRunFlags.promptedGitHubConnect)
        isGuest = false
        isAuthenticated = false
        currentUser = nil
        organization = OrganizationGraph(nodes: [], edges: [])
        workspaceMembers = []
        membersError = nil
        membersLoading = false
        userContext = ""
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
        let generation = sessionGeneration
        guard let base = backendBaseURL, let token = accountToken() else {
            throw AccountError.notSignedIn
        }
        var request = URLRequest(url: base.appending(path: "account"))
        request.httpMethod = "DELETE"
        request.timeoutInterval = 20
        request.setValue(token, forHTTPHeaderField: "x-session-token")

        let (data, response) = try await accountSession.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw AccountError.server(String(localized: "No response from the server."))
        }
        guard (200...299).contains(http.statusCode) else {
            let message = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["message"] as? String
            throw AccountError.server(message ?? String(localized: "Could not delete your account."))
        }
        // The deletion belongs to the identity that sent it. A later login or
        // demo session must not be signed out by the old request completing.
        guard generation == sessionGeneration, accountToken() == token else { return }
        signOut()
    }

    /// Switching repositories switches organizations, so the cards on screen
    /// belong to the old one and have to go. They are dropped locally only —
    /// they are still the other org's decisions, and deleting them there would
    /// take the rest of that team's pending work with them.
    ///
    /// The socket has to move too. It used to stay joined to the previous org,
    /// so after a switch the feed showed the new repository's name while
    /// receiving the old repository's decisions.
    func handleRepositoryChanged() async {
        cardService.reset()
        guard let connection = githubService.connection else { return }
        await activateGitHubSession(connection: connection)
    }
}
