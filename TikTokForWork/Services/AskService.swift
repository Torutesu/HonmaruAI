import Foundation

/// "Ask anything" from the phone: a question about a card, answered from the
/// card and what the team decided before. The Worker does the looking — a
/// keyword search over the team's decisions, its last eight, then the model —
/// and the phone shows what came back, in the reader's language. Nothing here
/// is computed on the device, so the web and the phone give the same answer.
enum AskService {
    enum Failure: LocalizedError, Equatable {
        case notSignedIn
        /// The Worker said no, in its own words: no model on this deployment,
        /// today's answers used up, a question too long.
        case refused(String)

        var errorDescription: String? {
            switch self {
            case .notSignedIn: String(localized: "Sign in to ask your AI.")
            case .refused(let message): message
            }
        }
    }

    /// An earlier decision the answer drew on.
    struct Related: Decodable, Identifiable, Equatable {
        let title: String
        let status: String
        let decidedAt: String?
        let recipient: String

        var id: String { "\(decidedAt ?? "pending")|\(title)" }

        /// The day it was decided, or that it is still waiting on someone.
        var when: String {
            guard let decidedAt, decidedAt.count >= 10 else { return String(localized: "Waiting") }
            return String(decidedAt.prefix(10))
        }
    }

    struct Answer: Decodable, Equatable {
        let answer: String
        let related: [Related]

        private enum CodingKeys: String, CodingKey { case answer, related }

        init(answer: String, related: [Related]) {
            self.answer = answer
            self.related = related
        }

        // A Worker that found nothing related sends none; that is still an
        // answer.
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            answer = try c.decode(String.self, forKey: .answer)
            related = try c.decodeIfPresent([Related].self, forKey: .related) ?? []
        }
    }

    /// The wire shape of `POST /ai/ask`.
    struct Question: Encodable {
        let orgId: String
        let cardId: String
        let question: String
        let readerLanguage: String
    }

    static func ask(cardId: String, orgId: String, question: String, readerLanguage: String, backendBaseURL: URL) async throws -> Answer {
        guard let token = SessionStore.sessionToken, !token.isEmpty else { throw Failure.notSignedIn }
        guard let url = URL(string: "/ai/ask", relativeTo: backendBaseURL) else {
            throw Failure.refused(String(localized: "Your AI could not answer that just now."))
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        // The Worker may make one model call after two D1 reads; a phone on a
        // slow link should wait for that rather than give up at the default.
        request.timeoutInterval = 45
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(token, forHTTPHeaderField: "x-session-token")
        if let key = SessionStore.apiKey, !key.isEmpty {
            request.setValue(key, forHTTPHeaderField: "x-ai-key")
        }
        request.httpBody = try JSONEncoder().encode(
            Question(orgId: orgId, cardId: cardId, question: question, readerLanguage: readerLanguage)
        )
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw Failure.refused(String(localized: "Your AI could not answer that just now."))
        }
        if http.statusCode == 401 { throw Failure.notSignedIn }
        guard (200...299).contains(http.statusCode) else {
            throw Failure.refused(message(in: data, status: http.statusCode))
        }
        return try JSONDecoder().decode(Answer.self, from: data)
    }

    /// What the Worker said, in its own words when it had any ("Your AI has
    /// no model to answer with on this deployment."), and one line of ours
    /// when the body was not the Worker's at all.
    static func message(in data: Data, status: Int) -> String {
        if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let message = json["message"] as? String, !message.isEmpty {
            return message
        }
        return String(localized: "Your AI could not answer that just now.")
    }
}
