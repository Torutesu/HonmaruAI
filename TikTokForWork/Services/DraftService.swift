import Foundation

/// The message back to whoever asked, drafted from the decision. A decision
/// is one tap; the message telling the person who asked was still typed by
/// hand. The Worker writes it from the card and the decision, in the language
/// the request came in, signed by the decider — and the phone shows it to be
/// read, changed and sent by the person. It is never sent from here.
enum DraftService {
    enum Failure: LocalizedError, Equatable {
        case notSignedIn
        /// The Worker said no, in its own words: not decided yet, not your
        /// card, no model on this deployment, today's answers used up.
        case refused(String)

        var errorDescription: String? {
            switch self {
            case .notSignedIn: String(localized: "Sign in to draft the reply.")
            case .refused(let message): message
            }
        }
    }

    struct Draft: Decodable, Equatable {
        let draft: String
        /// The language it was written in, from the Worker; absent on an
        /// older one.
        let language: String?
    }

    /// The wire shape of `POST /ai/draft`.
    struct Request: Encodable {
        let orgId: String
        let cardId: String
        let readerLanguage: String
    }

    static func draft(cardId: String, orgId: String, readerLanguage: String, backendBaseURL: URL) async throws -> Draft {
        guard let token = SessionStore.sessionToken, !token.isEmpty else { throw Failure.notSignedIn }
        guard let url = URL(string: "/ai/draft", relativeTo: backendBaseURL) else {
            throw Failure.refused(String(localized: "Your AI could not draft that just now."))
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 45
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(token, forHTTPHeaderField: "x-session-token")
        if let key = SessionStore.apiKey, !key.isEmpty {
            request.setValue(key, forHTTPHeaderField: "x-ai-key")
        }
        request.httpBody = try JSONEncoder().encode(Request(orgId: orgId, cardId: cardId, readerLanguage: readerLanguage))
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw Failure.refused(String(localized: "Your AI could not draft that just now."))
        }
        if http.statusCode == 401 { throw Failure.notSignedIn }
        guard (200...299).contains(http.statusCode) else {
            throw Failure.refused(message(in: data, status: http.statusCode))
        }
        return try JSONDecoder().decode(Draft.self, from: data)
    }

    /// The apps a reply can go back through, from here. The Worker knows
    /// which thread; the phone only knows whether to offer the button.
    static let sendable: Set<String> = ["Gmail", "Slack"]

    /// The wire shape of `POST /cards/:id/reply`.
    struct Outgoing: Encodable {
        let orgId: String
        let text: String
    }

    struct Sent: Decodable, Equatable {
        let sent: Bool
        let via: String?
    }

    /// Back the way it came: on the Gmail thread, in the Slack thread. The
    /// text is whatever is in the box by then — the draft, read and changed.
    static func send(cardId: String, orgId: String, text: String, backendBaseURL: URL) async throws -> Sent {
        guard let token = SessionStore.sessionToken, !token.isEmpty else { throw Failure.notSignedIn }
        guard let encoded = cardId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed),
              let url = URL(string: "cards/\(encoded)/reply", relativeTo: backendBaseURL) else {
            throw Failure.refused(String(localized: "Could not send."))
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 30
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(token, forHTTPHeaderField: "x-session-token")
        request.httpBody = try JSONEncoder().encode(Outgoing(orgId: orgId, text: text))
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw Failure.refused(String(localized: "Could not send.")) }
        if http.statusCode == 401 { throw Failure.notSignedIn }
        guard (200...299).contains(http.statusCode) else {
            throw Failure.refused(message(in: data, status: http.statusCode, fallback: String(localized: "Could not send.")))
        }
        return try JSONDecoder().decode(Sent.self, from: data)
    }

    /// What the Worker said, in its own words when it had any, and one line
    /// of ours when the body was not the Worker's at all.
    static func message(in data: Data, status: Int, fallback: String? = nil) -> String {
        if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let message = json["message"] as? String, !message.isEmpty {
            return message
        }
        return fallback ?? String(localized: "Your AI could not draft that just now.")
    }
}
