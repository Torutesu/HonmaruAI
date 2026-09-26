import Foundation

/// The person's profile on the Worker — today, one thing that matters: the
/// language their notifications are written in.
///
/// A push, a web push or an email is composed on the server, in whatever
/// language the server believes this person reads. The app is the authority
/// on that: the language toggle under **You** is the one explicit choice the
/// person makes, and it is mirrored here so a decision routed to them from a
/// Japanese teammate arrives on their lock screen in English — or the other
/// way round.
enum ProfileService {
    /// Tell the Worker what language this person reads. Never throws: a failure
    /// leaves the server on the language it seeded from the device on sign-in,
    /// and the next toggle, or the next launch, sends it again.
    static func setLocale(_ code: String, backendBaseURL: URL) async {
        guard let token = SessionStore.sessionToken, !token.isEmpty,
              let url = URL(string: "me", relativeTo: backendBaseURL) else { return }
        var request = URLRequest(url: url)
        request.httpMethod = "PUT"
        request.timeoutInterval = 15
        request.setValue(token, forHTTPHeaderField: "x-session-token")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["locale": code])
        _ = try? await URLSession.shared.data(for: request)
    }

    /// The account's language as the Worker has it — the one every device
    /// follows. Nil when it cannot be read; the app keeps what it has.
    static func locale(backendBaseURL: URL) async -> String? {
        guard let token = SessionStore.sessionToken, !token.isEmpty else { return nil }
        var request = URLRequest(url: backendBaseURL.appending(path: "me"))
        request.timeoutInterval = 15
        request.setValue(token, forHTTPHeaderField: "x-session-token")
        guard let (data, response) = try? await URLSession.shared.data(for: request),
              (response as? HTTPURLResponse)?.statusCode == 200,
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let code = json["locale"] as? String, !code.isEmpty else { return nil }
        return code
    }

    enum Failure: LocalizedError { case refused(String)
        var errorDescription: String? { if case .refused(let m) = self { return m }; return nil }
    }

    /// What this person does in the workspace, as the router reads it.
    static func role(orgId: String, backendBaseURL: URL) async -> String? {
        guard let token = SessionStore.sessionToken, !token.isEmpty,
              var components = URLComponents(url: backendBaseURL.appending(path: "me"), resolvingAgainstBaseURL: false) else { return nil }
        components.queryItems = [URLQueryItem(name: "orgId", value: orgId)]
        guard let url = components.url else { return nil }
        var request = URLRequest(url: url)
        request.timeoutInterval = 15
        request.setValue(token, forHTTPHeaderField: "x-session-token")
        guard let (data, _) = try? await URLSession.shared.data(for: request),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        return json["role"] as? String
    }

    /// Say what you do, in your own words. Standing never changes here.
    static func setRole(_ role: String, orgId: String, backendBaseURL: URL) async throws {
        guard let token = SessionStore.sessionToken, !token.isEmpty else { throw Failure.refused(String(localized: "Sign in first.")) }
        var request = URLRequest(url: backendBaseURL.appending(path: "me"))
        request.httpMethod = "PUT"
        request.timeoutInterval = 15
        request.setValue(token, forHTTPHeaderField: "x-session-token")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["orgId": orgId, "role": role])
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
            let message = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["message"] as? String
            throw Failure.refused(message ?? String(localized: "That did not save."))
        }
    }
}
