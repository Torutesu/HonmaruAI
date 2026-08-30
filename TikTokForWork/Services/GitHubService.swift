import AuthenticationServices
import Foundation

struct GitHubConnection {
    let username: String
    let repository: String
    let repositoryURL: String
}

struct GitHubOAuthConfig: Decodable {
    let clientId: String
    let redirectUri: String
    let scope: String
}

struct GitHubRepository: Identifiable, Decodable, Hashable {
    let id: Int
    let fullName: String
    let htmlURL: String
    let isPrivate: Bool

    enum CodingKeys: String, CodingKey {
        case id
        case fullName = "full_name"
        case htmlURL = "html_url"
        case isPrivate = "private"
    }
}

enum GitHubServiceError: LocalizedError {
    case missingCredentials
    case invalidRepository
    case unauthorized
    case oauthNotConfigured(String)
    case oauthCancelled
    case network(Error)
    case api(statusCode: Int, message: String)

    var errorDescription: String? {
        switch self {
        case .missingCredentials:
            String(localized: "GitHub account and repository are required.")
        case .invalidRepository:
            String(localized: "Repository not found or inaccessible.")
        case .unauthorized:
            String(localized: "GitHub authorization failed.")
        case .oauthNotConfigured(let message):
            message
        case .oauthCancelled:
            String(localized: "GitHub sign-in was cancelled.")
        case .network(let error):
            error.localizedDescription
        case .api(_, let message):
            message
        }
    }
}

@MainActor
final class GitHubService: NSObject, ObservableObject {
    @Published private(set) var connection: GitHubConnection?
    @Published private(set) var repositories: [GitHubRepository] = []
    @Published private(set) var lastError: String?

    var onRepositoryChanged: (() -> Void)?

    /// The relay session, not a GitHub token. GitHub credentials never reach
    /// the device — see `request(path:method:body:)`.
    private var token: String?
    private var repository = ""
    private var authSession: ASWebAuthenticationSession?
    private let webAuthContext = WebAuthContextProvider()

    var isConnected: Bool { connection != nil }
    var hasToken: Bool { token != nil }
    var linkedRepository: String { repository }

    func disconnect() {
        token = nil
        repository = ""
        connection = nil
        repositories = []
        lastError = nil
        authSession?.cancel()
        authSession = nil
        SessionStore.clear()
    }

    func restorePartialCredentials() {
        guard let savedSession = SessionStore.sessionToken, !savedSession.isEmpty else { return }
        token = savedSession
    }

    func restoreSavedSession() -> Bool {
        guard let savedSession = SessionStore.sessionToken, !savedSession.isEmpty,
              let savedRepository = SessionStore.githubRepository, !savedRepository.isEmpty else {
            return false
        }

        token = savedSession
        repository = savedRepository

        if let username = SessionStore.githubUsername,
           let repositoryURL = SessionStore.githubRepositoryURL {
            connection = GitHubConnection(
                username: username,
                repository: savedRepository,
                repositoryURL: repositoryURL
            )
        }

        return true
    }

    func validateSavedSession() async throws {
        guard token != nil else {
            throw GitHubServiceError.missingCredentials
        }

        if connection == nil, !repository.isEmpty {
            _ = try await connect(repository: repository)
            return
        }

        let user = try await requestDictionary(path: "/user")
        // Backfill the numeric id for installs that signed in before it was stored.
        if let ghId = user["id"] { SessionStore.githubUserId = String(describing: ghId) }
    }

    func signInWithOAuth(backendBaseURL: URL) async throws {
        let config = try await fetchOAuthConfig(backendBaseURL: backendBaseURL)
        // The nonce is issued by the server, put on the authorize URL, checked
        // on the way back, and spent at the exchange. `tiktokforwork://` is a
        // custom scheme, which iOS awards to any app that claims it — without
        // this, another app can hand us its own code and end up owning the
        // session we mint.
        let state = try await requestOAuthState(backendBaseURL: backendBaseURL)
        let code = try await requestAuthorizationCode(config: config, state: state)
        let sessionToken = try await exchangeCode(code, state: state, backendBaseURL: backendBaseURL)
        token = sessionToken
        repositories = try await fetchRepositories()
        lastError = nil
    }

    @discardableResult
    func refreshRepositories() async throws -> [GitHubRepository] {
        guard token != nil else {
            throw GitHubServiceError.missingCredentials
        }
        let updated = try await fetchRepositories()
        repositories = updated
        lastError = nil
        return updated
    }

    func connect(repository rawRepository: String) async throws -> GitHubConnection {
        guard let token, !token.isEmpty else {
            throw GitHubServiceError.missingCredentials
        }

        let trimmedRepo = rawRepository.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedRepo.isEmpty else {
            throw GitHubServiceError.missingCredentials
        }

        let previousRepo = repository
        self.repository = trimmedRepo
        lastError = nil

        let user = try await requestDictionary(path: "/user")
        guard let username = user["login"] as? String else {
            throw GitHubServiceError.unauthorized
        }
        // The numeric GitHub id is what the Worker (and therefore RevenueCat) keys on.
        if let ghId = user["id"] { SessionStore.githubUserId = String(describing: ghId) }

        let repo = try await requestDictionary(path: "/repos/\(trimmedRepo)")
        guard let fullName = repo["full_name"] as? String,
              let htmlURL = repo["html_url"] as? String else {
            throw GitHubServiceError.invalidRepository
        }

        let connection = GitHubConnection(
            username: username,
            repository: fullName,
            repositoryURL: htmlURL
        )
        self.connection = connection
        SessionStore.saveGitHubConnection(connection, repository: trimmedRepo)

        if !previousRepo.isEmpty, previousRepo != trimmedRepo {
            onRepositoryChanged?()
        }

        return connection
    }

    func syncDecision(_ card: DecisionCard) async throws -> (number: Int, url: String) {
        guard token != nil, !repository.isEmpty else {
            throw GitHubServiceError.missingCredentials
        }

        let title = "[\(card.type.label)] \(card.title)"
        let body = issueBody(for: card)

        if let number = card.githubIssueNumber {
            _ = try await request(
                path: "/repos/\(repository)/issues/\(number)",
                method: "PATCH",
                body: [
                    "title": title,
                    "body": body,
                    "state": githubIssueState(for: card.status)
                ]
            )
            let url = "https://github.com/\(repository)/issues/\(number)"
            return (number, url)
        }

        let response = try await requestDictionary(
            path: "/repos/\(repository)/issues",
            method: "POST",
            body: ["title": title, "body": body]
        )

        guard let number = response["number"] as? Int,
              let url = response["html_url"] as? String else {
            throw GitHubServiceError.api(statusCode: 0, message: "Unexpected GitHub response.")
        }

        return (number, url)
    }

    func issueState(number: Int) async throws -> String {
        let response = try await requestDictionary(path: "/repos/\(repository)/issues/\(number)")
        guard let state = response["state"] as? String else {
            throw GitHubServiceError.api(statusCode: 0, message: "Unexpected GitHub issue response.")
        }
        return state
    }

    private func githubIssueState(for status: CardStatus) -> String {
        switch status {
        case .completed, .rejected:
            "closed"
        default:
            "open"
        }
    }

    private func fetchOAuthConfig(backendBaseURL: URL) async throws -> GitHubOAuthConfig {
        let url = backendBaseURL.appending(path: "oauth/github/config")
        var configRequest = URLRequest(url: url)
        configRequest.timeoutInterval = 12
        let (data, response) = try await URLSession.shared.data(for: configRequest)
        guard let http = response as? HTTPURLResponse else {
            throw GitHubServiceError.api(statusCode: 0, message: "No response from relay server.")
        }

        if http.statusCode == 503 {
            let message = parseMessage(from: data) ?? "GitHub OAuth is not configured on localhost."
            throw GitHubServiceError.oauthNotConfigured(message)
        }

        guard (200...299).contains(http.statusCode) else {
            let message = parseMessage(from: data) ?? "Failed to load OAuth config."
            throw GitHubServiceError.api(statusCode: http.statusCode, message: message)
        }

        return try JSONDecoder().decode(GitHubOAuthConfig.self, from: data)
    }

    private func requestOAuthState(backendBaseURL: URL) async throws -> String {
        let url = backendBaseURL.appending(path: "oauth/github/state")
        var stateRequest = URLRequest(url: url)
        stateRequest.timeoutInterval = 12
        let (data, response) = try await URLSession.shared.data(for: stateRequest)
        guard let http = response as? HTTPURLResponse else {
            throw GitHubServiceError.api(statusCode: 0, message: "No response from relay server.")
        }
        guard (200...299).contains(http.statusCode),
              let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let state = json["state"] as? String,
              !state.isEmpty else {
            let message = parseMessage(from: data) ?? "Could not start GitHub sign-in."
            throw GitHubServiceError.api(statusCode: http.statusCode, message: message)
        }
        return state
    }

    private func requestAuthorizationCode(config: GitHubOAuthConfig, state: String) async throws -> String {
        var components = URLComponents(string: "https://github.com/login/oauth/authorize")
        components?.queryItems = [
            URLQueryItem(name: "client_id", value: config.clientId),
            URLQueryItem(name: "redirect_uri", value: config.redirectUri),
            URLQueryItem(name: "scope", value: config.scope),
            URLQueryItem(name: "state", value: state)
        ]

        guard let authURL = components?.url else {
            throw GitHubServiceError.api(statusCode: 0, message: "Invalid GitHub authorize URL.")
        }

        return try await withCheckedThrowingContinuation { continuation in
            let session = ASWebAuthenticationSession(
                url: authURL,
                callbackURLScheme: "tiktokforwork"
            ) { callbackURL, error in
                if let error {
                    let nsError = error as NSError
                    if nsError.domain == ASWebAuthenticationSessionErrorDomain,
                       nsError.code == ASWebAuthenticationSessionError.canceledLogin.rawValue {
                        continuation.resume(throwing: GitHubServiceError.oauthCancelled)
                        return
                    }
                    continuation.resume(throwing: GitHubServiceError.network(error))
                    return
                }

                guard
                    let callbackURL,
                    let components = URLComponents(url: callbackURL, resolvingAgainstBaseURL: false),
                    let code = components.queryItems?.first(where: { $0.name == "code" })?.value,
                    !code.isEmpty,
                    // A callback carrying someone else's nonce is someone else's
                    // sign-in. Refuse it here rather than letting the server be
                    // the only thing standing between us and their account.
                    components.queryItems?.first(where: { $0.name == "state" })?.value == state
                else {
                    continuation.resume(throwing: GitHubServiceError.unauthorized)
                    return
                }

                continuation.resume(returning: code)
            }

            session.presentationContextProvider = webAuthContext
            session.prefersEphemeralWebBrowserSession = false
            self.authSession = session
            session.start()
        }
    }

    private func exchangeCode(_ code: String, state: String, backendBaseURL: URL) async throws -> String {
        let url = backendBaseURL.appending(path: "oauth/github/token")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 15
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["code": code, "state": state])

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw GitHubServiceError.api(statusCode: 0, message: "No response from relay server.")
        }

        guard (200...299).contains(http.statusCode) else {
            let message = parseMessage(from: data) ?? "OAuth token exchange failed."
            throw GitHubServiceError.api(statusCode: http.statusCode, message: message)
        }

        guard
            let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
            let session = json["sessionToken"] as? String,
            !session.isEmpty
        else {
            throw GitHubServiceError.unauthorized
        }

        SessionStore.sessionToken = session
        if let login = json["login"] as? String, !login.isEmpty {
            SessionStore.githubUsername = login
        }
        return session
    }

    private func fetchRepositories() async throws -> [GitHubRepository] {
        let response = try await request(path: "/user/repos?per_page=100&sort=updated")
        guard let array = response as? [[String: Any]] else {
            return []
        }

        let data = try JSONSerialization.data(withJSONObject: array)
        return try JSONDecoder().decode([GitHubRepository].self, from: data)
    }

    private func issueBody(for card: DecisionCard) -> String {
        """
        | Field | Value |
        |---|---|
        | Status | \(card.status.rawValue) |
        | Priority | \(card.priority.rawValue) |
        | Type | \(card.type.label) |
        | From | \(card.senderName) |
        | Card ID | \(card.id) |

        ## Summary
        \(card.summary)

        ## Context
        \(card.context)
        \(labelsSection(for: card))
        """
    }

    private func labelsSection(for card: DecisionCard) -> String {
        guard let labels = card.labels, !labels.isEmpty else { return "" }
        return "\n\n## Labels\n" + labels.map { "- `\($0)`" }.joined(separator: "\n")
    }

    @discardableResult
    private func requestDictionary(
        path: String,
        method: String = "GET",
        body: [String: Any]? = nil
    ) async throws -> [String: Any] {
        let value = try await request(path: path, method: method, body: body)
        guard let dictionary = value as? [String: Any] else {
            throw GitHubServiceError.api(statusCode: 0, message: "Unexpected GitHub response.")
        }
        return dictionary
    }

    @discardableResult
    private func request(
        path: String,
        method: String = "GET",
        body: [String: Any]? = nil
    ) async throws -> Any {
        // GitHub is reached through the relay, not directly. The access token
        // it would take carries `repo` scope — every repository this person can
        // reach, code included — and this app opens issues. It stays on the
        // server, which forwards exactly the calls below and refuses the rest.
        guard let token else { throw GitHubServiceError.missingCredentials }
        guard let base = BackendURL.httpBase(from: AppConfig.relayURL) else {
            throw GitHubServiceError.invalidRepository
        }
        // Built by hand rather than with `appending(path:)`: some of these
        // paths carry a query string, and that would percent-encode the "?".
        let root = base.absoluteString.hasSuffix("/")
            ? String(base.absoluteString.dropLast())
            : base.absoluteString
        guard let url = URL(string: "\(root)/github\(path)") else {
            throw GitHubServiceError.invalidRepository
        }

        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue(token, forHTTPHeaderField: "x-session-token")
        request.setValue("application/json", forHTTPHeaderField: "Accept")

        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse else {
                throw GitHubServiceError.api(statusCode: 0, message: "No response from GitHub.")
            }

            if http.statusCode == 401 || http.statusCode == 403 {
                throw GitHubServiceError.unauthorized
            }

            guard (200...299).contains(http.statusCode) else {
                let message = parseMessage(from: data) ?? "GitHub request failed (\(http.statusCode))."
                throw GitHubServiceError.api(statusCode: http.statusCode, message: message)
            }

            if data.isEmpty {
                return [:]
            }

            return try JSONSerialization.jsonObject(with: data)
        } catch let error as GitHubServiceError {
            lastError = error.localizedDescription
            throw error
        } catch {
            let wrapped = GitHubServiceError.network(error)
            lastError = wrapped.localizedDescription
            throw wrapped
        }
    }

    private func parseMessage(from data: Data) -> String? {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return nil
        }
        return json["message"] as? String
    }
}

enum BackendURL {
    static func httpBase(from relayURL: String) -> URL? {
        let trimmed = relayURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard var components = URLComponents(string: trimmed) else { return nil }
        if components.scheme == "ws" {
            components.scheme = "http"
        } else if components.scheme == "wss" {
            components.scheme = "https"
        }
        return components.url
    }
}
