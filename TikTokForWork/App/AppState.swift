import Foundation

@MainActor
final class AppState: ObservableObject {
    @Published var currentUser: User?
    @Published var orgName: String?
    @Published var isAuthenticated = false
    @Published private(set) var isBootstrapping = true

    let cardService = DecisionCardService()
    let webSocketService = WebSocketService()

    var api: BackendAPI? {
        AppConfig.backendBaseURL.map { BackendAPI(baseURL: $0) }
    }

    init() {
        cardService.attach(webSocketService: webSocketService)
        Task { await restoreSessionIfNeeded() }
    }

    func restoreSessionIfNeeded() async {
        defer { isBootstrapping = false }
        guard SessionStore.hasSavedSession,
              let token = SessionStore.sessionToken,
              let userID = SessionStore.userID,
              let orgID = SessionStore.orgID else {
            return
        }
        let user = User(
            id: userID,
            name: SessionStore.userName ?? "You",
            role: "",
            teamID: nil,
            githubUsername: nil
        )
        await activateSession(
            token: token,
            user: user,
            orgID: orgID,
            orgName: SessionStore.orgName ?? "Workspace"
        )
    }

    func activateSession(token: String, user: User, orgID: String, orgName: String) async {
        SessionStore.save(
            token: token,
            userID: user.id,
            userName: user.name,
            orgID: orgID,
            orgName: orgName
        )
        cardService.currentUserID = user.id
        do {
            try await webSocketService.connect(
                urlString: AppConfig.backendWS,
                token: token,
                orgId: orgID
            )
        } catch {
            // The socket retries in the background; the feed fills on join.
        }
        currentUser = user
        self.orgName = orgName
        isAuthenticated = true
    }

    func createInviteCode() async -> String? {
        guard let api,
              let token = SessionStore.sessionToken,
              let orgID = SessionStore.orgID else { return nil }
        return try? await api.createInvite(token: token, orgID: orgID)
    }

    func signOut() {
        webSocketService.disconnect(intentional: true)
        cardService.reset()
        OrgDirectory.shared.reset()
        SessionStore.clear()
        isAuthenticated = false
        currentUser = nil
        orgName = nil
    }
}
