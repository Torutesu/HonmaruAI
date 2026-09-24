import Foundation

/// The thread under a card, from the phone: what people said about it, an
/// @mention that reaches whoever was named, one-emoji reactions. The Worker
/// keeps all of it per workspace; the phone shows what comes back and says
/// the next thing.
enum ThreadService {
    enum Failure: LocalizedError, Equatable {
        case notSignedIn
        case refused(String)

        var errorDescription: String? {
            switch self {
            case .notSignedIn: String(localized: "Sign in to reply.")
            case .refused(let message): message
            }
        }
    }

    struct Comment: Decodable, Identifiable, Equatable {
        let id: String
        let author: String
        let authorName: String?
        let body: String
        let mentions: [String]
        let createdAt: String

        private enum CodingKeys: String, CodingKey { case id, author, authorName, body, mentions, createdAt }

        init(id: String, author: String, authorName: String?, body: String, mentions: [String], createdAt: String) {
            self.id = id; self.author = author; self.authorName = authorName
            self.body = body; self.mentions = mentions; self.createdAt = createdAt
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            id = try c.decode(String.self, forKey: .id)
            author = try c.decode(String.self, forKey: .author)
            authorName = try c.decodeIfPresent(String.self, forKey: .authorName)
            body = try c.decode(String.self, forKey: .body)
            mentions = try c.decodeIfPresent([String].self, forKey: .mentions) ?? []
            createdAt = try c.decode(String.self, forKey: .createdAt)
        }

        /// Who wrote it, as a name — never the account id.
        var displayAuthor: String {
            if let authorName, !authorName.isEmpty { return authorName }
            return DisplayName.of(author)
        }
    }

    struct Reaction: Decodable, Identifiable, Equatable {
        let emoji: String
        let count: Int
        let mine: Bool
        let names: [String]
        var id: String { emoji }
    }

    struct Thread: Decodable, Equatable {
        let comments: [Comment]
        let reactions: [Reaction]
        let available: [String]

        private enum CodingKeys: String, CodingKey { case comments, reactions, available }

        init(comments: [Comment], reactions: [Reaction], available: [String]) {
            self.comments = comments; self.reactions = reactions; self.available = available
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            comments = try c.decodeIfPresent([Comment].self, forKey: .comments) ?? []
            reactions = try c.decodeIfPresent([Reaction].self, forKey: .reactions) ?? []
            available = try c.decodeIfPresent([String].self, forKey: .available) ?? []
        }
    }

    private struct Posted: Decodable { let comment: Comment }
    private struct Toggled: Decodable { let on: Bool; let reactions: [Reaction] }

    static func load(cardId: String, orgId: String, backendBaseURL: URL) async throws -> Thread {
        var components = URLComponents(url: backendBaseURL.appending(path: "cards/\(cardId)/comments"), resolvingAgainstBaseURL: false)
        components?.queryItems = [URLQueryItem(name: "orgId", value: orgId)]
        guard let url = components?.url else { throw Failure.refused(String(localized: "The thread could not be loaded.")) }
        var request = try authed(url, method: "GET")
        request.timeoutInterval = 20
        let data = try await perform(request)
        return try JSONDecoder().decode(Thread.self, from: data)
    }

    /// Say something under the card. `@Name` in the text reaches that person.
    static func post(cardId: String, orgId: String, body: String, backendBaseURL: URL) async throws -> Comment {
        let url = backendBaseURL.appending(path: "cards/\(cardId)/comments")
        var request = try authed(url, method: "POST")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["orgId": orgId, "body": body])
        let data = try await perform(request)
        return try JSONDecoder().decode(Posted.self, from: data).comment
    }

    /// One emoji on, or off again.
    static func react(cardId: String, orgId: String, emoji: String, backendBaseURL: URL) async throws -> [Reaction] {
        let url = backendBaseURL.appending(path: "cards/\(cardId)/reactions")
        var request = try authed(url, method: "POST")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["orgId": orgId, "emoji": emoji])
        let data = try await perform(request)
        return try JSONDecoder().decode(Toggled.self, from: data).reactions
    }

    private static func authed(_ url: URL, method: String) throws -> URLRequest {
        guard let token = SessionStore.sessionToken, !token.isEmpty else { throw Failure.notSignedIn }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = 20
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(token, forHTTPHeaderField: "x-session-token")
        return request
    }

    private static func perform(_ request: URLRequest) async throws -> Data {
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw Failure.refused(String(localized: "The thread could not be loaded."))
        }
        if http.statusCode == 401 { throw Failure.notSignedIn }
        guard (200...299).contains(http.statusCode) else {
            throw Failure.refused(AskService.message(in: data, status: http.statusCode))
        }
        return data
    }
}
