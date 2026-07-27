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
            "GitHub account and repository are required."
        case .invalidRepository:
            "Repository not found or inaccessible."
        case .unauthorized:
            "GitHub authorization failed."
        case .oauthNotConfigured(let message):
            message
        case .oauthCancelled:
            "GitHub sign-in was cancelled."
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

    private var token: String?
    private var repository = ""
    private var authSession: ASWebAuthenticationSession?
    private let webAuthContext = WebAuthContextProvider()

    var isConnected: Bool { connection != nil }
    var hasToken: Bool { token != nil }

    func disconnect() {
        token = nil
        repository = ""
        connection = nil
        repositories = []
        lastError = nil
        authSession?.cancel()
        authSession = nil
    }

    func signInWithOAuth(backendBaseURL: URL) async throws {
        let config = try await fetchOAuthConfig(backendBaseURL: backendBaseURL)
        let code = try await requestAuthorizationCode(config: config)
        let accessToken = try await exchangeCode(code, backendBaseURL: backendBaseURL)
        token = accessToken
        repositories = try await fetchRepositories()
        lastError = nil
    }

    func connect(repository rawRepository: String) async throws -> GitHubConnection {
        guard let token, !token.isEmpty else {
            throw GitHubServiceError.missingCredentials
        }

        let trimmedRepo = rawRepository.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedRepo.isEmpty else {
            throw GitHubServiceError.missingCredentials
        }

        self.repository = trimmedRepo
        lastError = nil

        let user = try await requestDictionary(path: "/user")
        guard let username = user["login"] as? String else {
            throw GitHubServiceError.unauthorized
        }

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
                    "state": card.status == .approved ? "closed" : "open"
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

    private func fetchOAuthConfig(backendBaseURL: URL) async throws -> GitHubOAuthConfig {
        let url = backendBaseURL.appending(path: "oauth/github/config")
        let (data, response) = try await URLSession.shared.data(from: url)
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

    private func requestAuthorizationCode(config: GitHubOAuthConfig) async throws -> String {
        var components = URLComponents(string: "https://github.com/login/oauth/authorize")
        components?.queryItems = [
            URLQueryItem(name: "client_id", value: config.clientId),
            URLQueryItem(name: "redirect_uri", value: config.redirectUri),
            URLQueryItem(name: "scope", value: config.scope)
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
                    !code.isEmpty
                else {
                    continuation.resume(throwing: GitHubServiceError.unauthorized)
                    return
                }

                continuation.resume(returning: code)
            }

            session.presentationContextProvider = webAuthContext
            session.prefersEphemeralWebBrowserSession = true
            self.authSession = session
            session.start()
        }
    }

    private func exchangeCode(_ code: String, backendBaseURL: URL) async throws -> String {
        let url = backendBaseURL.appending(path: "oauth/github/token")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["code": code])

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
            let accessToken = json["accessToken"] as? String,
            !accessToken.isEmpty
        else {
            throw GitHubServiceError.unauthorized
        }

        return accessToken
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
        """
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
        guard let token else { throw GitHubServiceError.missingCredentials }
        guard let url = URL(string: "https://api.github.com\(path)") else {
            throw GitHubServiceError.invalidRepository
        }

        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        request.setValue("2022-11-28", forHTTPHeaderField: "X-GitHub-Api-Version")
        request.setValue("TikTokForWork-iOS/1.0", forHTTPHeaderField: "User-Agent")

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
