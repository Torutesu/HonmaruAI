import Foundation

/// Signing in with a code sent to your email.
///
/// The app shipped with one way in — GitHub — which is right for the engineer
/// on the team and wrong for the six people who are not. A code proves the
/// address every notification this app sends depends on, needs nothing set up
/// beforehand, and works on a phone the person has just installed this on.
///
/// Two calls, no state. The Worker holds the code; this holds nothing.
enum EmailAuthService {
    struct Session {
        let token: String
        /// The id the Worker keys this account by — the same value `entitlements.js`
        /// looks a RevenueCat subscriber up with. Distinct from `login`, which is a
        /// display handle; an account can share a handle shape with its email address.
        let login: String
        let userID: String
        let orgId: String
        let created: Bool
    }

    enum Failure: LocalizedError {
        /// The deployment cannot send mail at all. Worth its own case: the UI
        /// says so plainly rather than leaving someone waiting for an email.
        case mailNotConfigured
        case message(String)
        case unreachable
        case invalidSession

        var errorDescription: String? {
            switch self {
            case .mailNotConfigured:
                String(localized: "This workspace cannot send email yet. Sign in with a password.")
            case .message(let text): text
            case .unreachable:
                String(localized: "Could not reach the server. Check your connection and try again.")
            case .invalidSession:
                String(localized: "Sign in")
            }
        }
    }

    /// Restore server-authoritative identity and membership, not cached keychain values.
    static func restore(token: String, baseURL: URL, session: URLSession = .shared) async throws -> Session {
        var request = URLRequest(url: baseURL.appendingPathComponent("me"))
        request.timeoutInterval = 20
        request.setValue(token, forHTTPHeaderField: "x-session-token")
        let (data, response) = try await session.data(for: request)
        try Task.checkCancellation()
        guard let http = response as? HTTPURLResponse else { throw Failure.unreachable }
        return try decodeRestoredSession(data, status: http.statusCode, token: token)
    }

    static func decodeRestoredSession(_ data: Data, status: Int, token: String) throws -> Session {
        // /me returns 409 when the session's account no longer exists.
        if status == 401 || status == 409 { throw Failure.invalidSession }
        guard (200...299).contains(status),
              var json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              json.keys.contains("orgId") else { throw Failure.unreachable }
        json["token"] = token
        return try decodeSession(json)
    }

    private static func post(_ path: String, body: [String: Any], baseURL: URL?, session: URLSession) async throws -> [String: Any] {
        // The same scheme swap every other caller uses. Doing it by hand here
        // would rewrite any "ws" inside the hostname too.
        guard let base = baseURL ?? BackendURL.httpBase(from: AppConfig.relayURL) else {
            throw Failure.unreachable
        }
        let url = base.appendingPathComponent(path)
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 20
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        // The language the code email is written in, and the one a new
        // account starts with. URLSession's own header lists the app's
        // localizations, which named English for anyone whose language the
        // screens are not translated into.
        request.setValue(AppLocalization.language.readerLanguageCode, forHTTPHeaderField: "Accept-Language")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            if Task.isCancelled { throw CancellationError() }
            throw Failure.unreachable
        }
        try Task.checkCancellation()
        let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        guard let http = response as? HTTPURLResponse else { throw Failure.unreachable }
        if http.statusCode == 503, path == "auth/otp/request" { throw Failure.mailNotConfigured }
        if http.statusCode >= 500 { throw Failure.unreachable }
        guard (200...299).contains(http.statusCode) else {
            throw Failure.message((json["message"] as? String) ?? String(localized: "Something went wrong."))
        }
        return json
    }

    /// Ask for a code. Answers the same way whether or not the address has an
    /// account here — the server does that deliberately, and so does this.
    static func requestCode(email: String, baseURL: URL? = nil, session: URLSession = .shared) async throws {
        _ = try await post("auth/otp/request", body: ["email": normalizedEmail(email)], baseURL: baseURL, session: session)
    }

    /// Sign in with a password.
    ///
    /// The code is the front door and this is the other one. It exists for two
    /// people. The first is anyone on a deployment that cannot send mail at
    /// all: the code path answers 503 there, and telling them to use GitHub is
    /// a dead end for exactly the people this sign-in was added for. The second
    /// is an App Store reviewer, who has no GitHub account and no way to
    /// receive a code sent to an address they do not own — an app they cannot
    /// sign in to is rejected under Guideline 2.1, and a demo account with a
    /// password is the answer Apple asks for.
    ///
    /// Identity and active workspace are returned by the server for all users.
    static func signIn(email: String, password: String, baseURL: URL? = nil, session: URLSession = .shared) async throws -> Session {
        let json = try await post("auth/login", body: ["email": normalizedEmail(email), "password": password], baseURL: baseURL, session: session)
        return try decodeSession(json)
    }

    /// Trade a code for a session, creating the account if this address has
    /// never been here. `name` and `inviteCode` are only used in that case.
    static func verifyCode(email: String, code: String, name: String, inviteCode: String, baseURL: URL? = nil, session: URLSession = .shared) async throws -> Session {
        var body: [String: Any] = ["email": normalizedEmail(email), "code": code]
        if !name.isEmpty { body["name"] = name }
        if !inviteCode.isEmpty { body["inviteCode"] = inviteCode }
        let json = try await post("auth/otp/verify", body: body, baseURL: baseURL, session: session)
        return try decodeSession(json)
    }

    static func decodeSession(_ json: [String: Any]) throws -> Session {
        guard let token = json["token"] as? String, !token.isEmpty,
              let login = json["login"] as? String, !login.isEmpty,
              let userID = json["userId"] as? String, !userID.isEmpty else {
            throw Failure.unreachable
        }
        return Session(
            token: token,
            login: login,
            userID: userID,
            orgId: (json["orgId"] as? String) ?? "",
            created: (json["created"] as? Bool) ?? false
        )
    }

    static func normalizedEmail(_ email: String) -> String {
        email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }
}
