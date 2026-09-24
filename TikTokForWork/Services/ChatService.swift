import Foundation

// Channels you can talk in, as the Worker serves them to the web: a
// business's channel (`b:<slug>`), a direct conversation (`dm:<ref>`), and
// everything Slack lets you do to a message. The phone speaks the same
// routes; nothing here is computed that the Worker does not also know.

struct ChatReaction: Codable, Hashable {
    let emoji: String
    var count: Int
    var refs: [String]
    var mine: Bool
}

struct ChatMessage: Codable, Identifiable, Hashable {
    let id: String
    var channel: String
    var kind: String
    var body: String
    var authorName: String?
    var authorRef: String?
    var mine: Bool
    var cardId: String?
    var createdAt: String
    var editedAt: String?
    var deleted: Bool?
    var parentId: String?
    var replyCount: Int?
    var lastReplyAt: String?
    var replyRefs: [String]?
    var pinned: Bool?
    var reactions: [ChatReaction]?

    var isAI: Bool { kind == "ai" }
    var isDeleted: Bool { deleted == true }
    var date: Date { ChatDates.parse(createdAt) ?? .distantPast }
}

struct ChatMemberStatus: Codable, Hashable {
    let emoji: String?
    let text: String?
    let until: String?
}

struct ChatMember: Codable, Identifiable, Hashable {
    let ref: String
    let name: String
    let title: String?
    let mine: Bool
    let loginHash: String?
    let handle: String?
    let status: ChatMemberStatus?
    let awayUntil: String?
    var id: String { ref }
}

struct ChatActivity: Codable, Hashable {
    let channel: String
    let lastAt: String
    let preview: String
    let lastBy: String?
}

struct ChatBusiness: Codable, Identifiable, Hashable {
    let slug: String
    let name: String
    var id: String { slug }
}

struct ChatMine: Codable, Hashable {
    let status: ChatMemberStatus?
    let awayUntil: String?
    let delegateRef: String?
}

struct ChatOverview: Codable {
    let activity: [ChatActivity]
    let members: [ChatMember]
    let reads: [String: String]?
    let prefs: [String: String]?
    let mine: ChatMine?
}

struct ChatActivityItem: Codable, Identifiable, Hashable {
    let type: String
    let message: ChatMessage
    var unread: Bool
    var id: String { "\(type)-\(message.id)" }
}

struct ChatThread: Codable {
    var parent: ChatMessage
    var replies: [ChatMessage]
}

struct ChatScheduled: Codable, Identifiable, Hashable {
    let id: String
    let body: String
    let sendAt: String
    let channel: String?
    let parentId: String?
}

struct ChatSaved: Codable, Identifiable, Hashable {
    let id: String
    let remindAt: String?
    let remindedAt: String?
    let message: ChatMessage
}

struct ChatProfile: Codable, Hashable {
    struct Stats: Codable, Hashable { let waiting: Int; let decided90d: Int; let medianMinutes: Int? }
    let ref: String
    let name: String
    let handle: String?
    let title: String
    let timezone: String?
    let status: ChatMemberStatus?
    let awayUntil: String?
    let mine: Bool?
    let stats: Stats
}

/// What the AI is doing with a message it was asked to decide from.
struct ChatProgress: Hashable {
    let channel: String
    let step: String
}

enum ChatDates {
    private static let withFraction: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    private static let plain = ISO8601DateFormatter()
    static func parse(_ s: String?) -> Date? {
        guard let s else { return nil }
        return withFraction.date(from: s) ?? plain.date(from: s)
    }
    static func string(_ d: Date) -> String { withFraction.string(from: d) }
}

enum ChatService {
    enum Failure: LocalizedError {
        case notSignedIn
        case server(Int, String?)
        var errorDescription: String? {
            switch self {
            case .notSignedIn: String(localized: "Sign in to talk with your team.")
            case .server(_, let message): message ?? String(localized: "That did not work. Try again.")
            }
        }
    }

    private struct Message: Decodable { let message: String? }

    /// One call to the Worker, with this device's session.
    static func call<T: Decodable>(_ method: String, _ path: String, base: URL, query: [String: String] = [:], body: [String: Any]? = nil, as type: T.Type) async throws -> T {
        guard let token = SessionStore.sessionToken else { throw Failure.notSignedIn }
        var components = URLComponents(url: base, resolvingAgainstBaseURL: true)
        components?.path = path
        if !query.isEmpty { components?.queryItems = query.map { URLQueryItem(name: $0.key, value: $0.value) } }
        guard let url = components?.url else { throw Failure.server(0, nil) }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = 20
        request.setValue(token, forHTTPHeaderField: "x-session-token")
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        }
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw Failure.server(0, nil) }
        guard (200...299).contains(http.statusCode) else {
            if http.statusCode == 401 { throw Failure.notSignedIn }
            throw Failure.server(http.statusCode, (try? JSONDecoder().decode(Message.self, from: data))?.message)
        }
        return try JSONDecoder().decode(type, from: data)
    }

    // MARK: Reading

    static func overview(orgId: String, base: URL) async throws -> ChatOverview {
        var q = ["orgId": orgId]
        q["tz"] = TimeZone.current.identifier
        return try await call("GET", "/channels", base: base, query: q, as: ChatOverview.self)
    }

    static func businesses(orgId: String, base: URL) async throws -> [ChatBusiness] {
        struct R: Decodable { let businesses: [ChatBusiness] }
        return try await call("GET", "/businesses", base: base, query: ["orgId": orgId], as: R.self).businesses
    }

    static func messages(orgId: String, channel: String, before: String? = nil, base: URL) async throws -> [ChatMessage] {
        struct R: Decodable { let messages: [ChatMessage] }
        var q = ["orgId": orgId, "channel": channel]
        if let before { q["before"] = before }
        return try await call("GET", "/channels/messages", base: base, query: q, as: R.self).messages
    }

    static func thread(orgId: String, channel: String, messageId: String, base: URL) async throws -> ChatThread {
        try await call("GET", "/channels/thread", base: base, query: ["orgId": orgId, "channel": channel, "messageId": messageId], as: ChatThread.self)
    }

    static func pins(orgId: String, channel: String, base: URL) async throws -> [ChatMessage] {
        struct R: Decodable { let messages: [ChatMessage] }
        return try await call("GET", "/channels/pins", base: base, query: ["orgId": orgId, "channel": channel], as: R.self).messages
    }

    static func activity(orgId: String, base: URL) async throws -> [ChatActivityItem] {
        struct R: Decodable { let items: [ChatActivityItem] }
        return try await call("GET", "/channels/activity", base: base, query: ["orgId": orgId], as: R.self).items
    }

    static func search(orgId: String, query: String, base: URL) async throws -> [ChatMessage] {
        struct R: Decodable { let messages: [ChatMessage] }
        return try await call("GET", "/channels/search", base: base, query: ["orgId": orgId, "q": query], as: R.self).messages
    }

    static func scheduled(orgId: String, base: URL) async throws -> [ChatScheduled] {
        struct R: Decodable { let scheduled: [ChatScheduled] }
        return try await call("GET", "/channels/scheduled", base: base, query: ["orgId": orgId], as: R.self).scheduled
    }

    static func later(orgId: String, base: URL) async throws -> [ChatSaved] {
        struct R: Decodable { let items: [ChatSaved] }
        return try await call("GET", "/channels/later", base: base, query: ["orgId": orgId], as: R.self).items
    }

    static func profile(orgId: String, ref: String, base: URL) async throws -> ChatProfile {
        struct R: Decodable { let member: ChatProfile }
        return try await call("GET", "/channels/member", base: base, query: ["orgId": orgId, "ref": ref], as: R.self).member
    }

    // MARK: Writing

    struct Sent: Decodable {
        let message: ChatMessage?
        let deciding: Bool?
        let scheduled: ChatScheduled?
    }

    static func send(orgId: String, channel: String, body: String, decide: Bool = false, parentId: String? = nil, sendAt: Date? = nil, base: URL) async throws -> Sent {
        var b: [String: Any] = ["orgId": orgId, "channel": channel, "body": body, "decide": decide]
        if let parentId { b["parentId"] = parentId }
        if let sendAt { b["sendAt"] = ChatDates.string(sendAt) }
        return try await call("POST", "/channels/messages", base: base, body: b, as: Sent.self)
    }

    static func edit(orgId: String, channel: String, messageId: String, body: String, base: URL) async throws -> ChatMessage? {
        try await call("PUT", "/channels/messages", base: base, body: ["orgId": orgId, "channel": channel, "messageId": messageId, "body": body], as: Sent.self).message
    }

    static func delete(orgId: String, channel: String, messageId: String, base: URL) async throws -> ChatMessage? {
        try await call("DELETE", "/channels/messages", base: base, body: ["orgId": orgId, "channel": channel, "messageId": messageId], as: Sent.self).message
    }

    static func react(orgId: String, channel: String, messageId: String, emoji: String, base: URL) async throws -> ChatMessage? {
        try await call("POST", "/channels/reactions", base: base, body: ["orgId": orgId, "channel": channel, "messageId": messageId, "emoji": emoji], as: Sent.self).message
    }

    static func pin(orgId: String, channel: String, messageId: String, pinned: Bool, base: URL) async throws -> ChatMessage? {
        try await call("POST", "/channels/pins", base: base, body: ["orgId": orgId, "channel": channel, "messageId": messageId, "pinned": pinned], as: Sent.self).message
    }

    static func decide(orgId: String, channel: String, messageId: String, base: URL) async throws {
        struct R: Decodable { let deciding: Bool? }
        _ = try await call("POST", "/channels/decide", base: base, body: ["orgId": orgId, "channel": channel, "messageId": messageId], as: R.self)
    }

    static func markRead(orgId: String, channel: String, base: URL) async {
        struct R: Decodable { let lastReadAt: String? }
        _ = try? await call("POST", "/channels/read", base: base, body: ["orgId": orgId, "channel": channel], as: R.self)
    }

    static func cancelScheduled(orgId: String, id: String, base: URL) async throws {
        struct R: Decodable { let ok: Bool? }
        _ = try await call("DELETE", "/channels/scheduled", base: base, body: ["orgId": orgId, "id": id], as: R.self)
    }

    static func saveForLater(orgId: String, channel: String, messageId: String, remindAt: Date?, base: URL) async throws {
        struct R: Decodable { let id: String? }
        var b: [String: Any] = ["orgId": orgId, "channel": channel, "messageId": messageId]
        if let remindAt { b["remindAt"] = ChatDates.string(remindAt) }
        _ = try await call("POST", "/channels/later", base: base, body: b, as: R.self)
    }

    static func finishLater(orgId: String, id: String, base: URL) async throws {
        struct R: Decodable { let ok: Bool? }
        _ = try await call("DELETE", "/channels/later", base: base, body: ["orgId": orgId, "id": id], as: R.self)
    }

    static func clip(orgId: String, channel: String, items: [(channel: String, id: String)], instruction: String, base: URL) async throws -> Sent {
        try await call("POST", "/channels/clip", base: base, body: [
            "orgId": orgId, "channel": channel, "instruction": instruction,
            "items": items.map { ["channel": $0.channel, "messageId": $0.id] },
        ], as: Sent.self)
    }

    static func setPref(orgId: String, channel: String, level: String, base: URL) async throws {
        struct R: Decodable { let ok: Bool? }
        _ = try await call("PUT", "/channels/prefs", base: base, body: ["orgId": orgId, "channel": channel, "level": level], as: R.self)
    }

    static func setStatus(orgId: String, emoji: String?, text: String?, until: Date?, awayUntil: Date?, delegateRef: String?, base: URL) async throws {
        struct R: Decodable { let ok: Bool? }
        var b: [String: Any] = ["orgId": orgId]
        if let emoji { b["emoji"] = emoji }
        if let text { b["text"] = text }
        if let until { b["until"] = ChatDates.string(until) }
        if let awayUntil { b["awayUntil"] = ChatDates.string(awayUntil) }
        if let delegateRef { b["delegateRef"] = delegateRef }
        _ = try await call("PUT", "/channels/status", base: base, body: b, as: R.self)
    }

    static func createChannel(orgId: String, name: String, base: URL) async throws -> [ChatBusiness] {
        struct R: Decodable { let businesses: [ChatBusiness] }
        return try await call("POST", "/businesses", base: base, body: ["orgId": orgId, "name": name], as: R.self).businesses
    }

    static func addAutoRule(orgId: String, cardId: String, base: URL) async throws {
        struct R: Decodable { let id: String? }
        _ = try await call("POST", "/channels/auto-rules", base: base, body: ["orgId": orgId, "cardId": cardId], as: R.self)
    }

    static func remember(orgId: String, text: String, base: URL) async throws {
        struct R: Decodable {}
        _ = try await call("POST", "/memories", base: base, body: ["orgId": orgId, "text": text], as: R.self)
    }

    /// "/routine every Monday at 9 …": understood by the Worker, then made.
    static func routine(orgId: String, text: String, locale: String, base: URL) async throws -> String {
        struct Parsed: Decodable {
            let cadence: String?; let hour: Int?; let minute: Int?; let weekday: Int?; let monthday: Int?
            let instruction: String?; let schedule: String?
        }
        struct P: Decodable { let parsed: Parsed? }
        struct R: Decodable {}
        guard let parsed = try await call("POST", "/routines/parse", base: base, body: ["text": text, "locale": locale], as: P.self).parsed,
              let cadence = parsed.cadence else {
            throw Failure.server(400, String(localized: "Say when, too — e.g. every Monday at 9, or every day at 18:00."))
        }
        var b: [String: Any] = ["orgId": orgId, "kind": "report", "instruction": parsed.instruction ?? text, "cadence": cadence, "hour": parsed.hour ?? 9, "minute": parsed.minute ?? 0]
        if let w = parsed.weekday { b["weekday"] = w }
        if let d = parsed.monthday { b["monthday"] = d }
        _ = try await call("POST", "/routines", base: base, body: b, as: R.self)
        return parsed.schedule ?? ""
    }

    // MARK: You

    struct Me: Decodable { let name: String?; let handle: String? }

    static func me(base: URL) async throws -> Me {
        try await call("GET", "/me", base: base, as: Me.self)
    }

    static func saveIdentity(name: String?, handle: String?, base: URL) async throws -> Me {
        var b: [String: Any] = [:]
        if let name { b["name"] = name }
        if let handle { b["handle"] = handle }
        return try await call("PUT", "/me", base: base, body: b, as: Me.self)
    }
}

/// The relay's channel events, forwarded from the socket to whoever is
/// listening — the chat store — without widening the card event enum.
extension Notification.Name {
    static let chatMessageEvent = Notification.Name("honmaru.chat.message")
    static let chatProgressEvent = Notification.Name("honmaru.chat.progress")
}
