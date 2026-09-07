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
        let login: String
        let orgId: String
        let created: Bool
    }

    enum Failure: LocalizedError {
        /// The deployment cannot send mail at all. Worth its own case: the UI
        /// says so plainly rather than leaving someone waiting for an email.
        case mailNotConfigured
        case message(String)
        case unreachable

        var errorDescription: String? {
            switch self {
            case .mailNotConfigured:
                String(localized: "This workspace cannot send email yet. Sign in with GitHub for now.")
            case .message(let text): text
            case .unreachable:
                String(localized: "Could not reach the server. Check your connection and try again.")
            }
        }
    }

    private static func post(_ path: String, body: [String: Any]) async throws -> [String: Any] {
        // The same scheme swap every other caller uses. Doing it by hand here
        // would rewrite any "ws" inside the hostname too.
        guard let base = BackendURL.httpBase(from: AppConfig.relayURL),
              let url = URL(string: path, relativeTo: base) else {
            throw Failure.unreachable
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await URLSession.shared.data(for: request)
        } catch {
            throw Failure.unreachable
        }
        let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        guard let http = response as? HTTPURLResponse else { throw Failure.unreachable }
        if http.statusCode == 503 { throw Failure.mailNotConfigured }
        guard (200...299).contains(http.statusCode) else {
            throw Failure.message((json["message"] as? String) ?? String(localized: "Something went wrong."))
        }
        return json
    }

    /// Ask for a code. Answers the same way whether or not the address has an
    /// account here — the server does that deliberately, and so does this.
    static func requestCode(email: String) async throws {
        _ = try await post("auth/otp/request", body: ["email": email])
    }

    /// Trade a code for a session, creating the account if this address has
    /// never been here. `name` and `inviteCode` are only used in that case.
    static func verifyCode(email: String, code: String, name: String, inviteCode: String) async throws -> Session {
        var body: [String: Any] = ["email": email, "code": code]
        if !name.isEmpty { body["name"] = name }
        if !inviteCode.isEmpty { body["inviteCode"] = inviteCode }
        let json = try await post("auth/otp/verify", body: body)
        guard let token = json["token"] as? String else {
            throw Failure.message(String(localized: "That code is not valid. Ask for a new one."))
        }
        return Session(
            token: token,
            login: (json["login"] as? String) ?? (json["userId"] as? String) ?? email,
            orgId: (json["orgId"] as? String) ?? "",
            created: (json["created"] as? Bool) ?? false
        )
    }
}
