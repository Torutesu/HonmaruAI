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

/// A file or a picture on a message. `url` is a signed path on the Worker,
/// good for a day or two; it is resolved against the API's base.
struct ChatFile: Codable, Identifiable, Hashable {
    let id: String
    let name: String
    let type: String
    let size: Int
    let width: Int?
    let height: Int?
    let url: String

    var isPicture: Bool { ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"].contains(type) }
    func address(base: URL) -> URL? { URL(string: url, relativeTo: base)?.absoluteURL }
}

/// One of the workspace's own emoji: `:name:`, drawn from a picture only
/// this workspace has.
struct ChatEmoji: Codable, Identifiable, Hashable {
    let name: String
    let url: String
    var id: String { name }
}

/// A group DM: three to nine people, `g:<id>`.
struct ChatGroup: Codable, Hashable {
    let view: String
    let refs: [String]
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
    var files: [ChatFile]?
    /// Set when one of the team's agents wrote it: its name and face.
    var agent: ChatAgentFace?

    var isAI: Bool { kind == "ai" }
    /// Written by an agent the team made ("@hayao"), not by a person.
    var isAgent: Bool { kind == "agent" }
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
    /// A private channel: only its members see it at all.
    var isPrivate: Bool?
    var id: String { slug }

    enum CodingKeys: String, CodingKey { case slug, name, isPrivate = "private" }
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
    let groups: [ChatGroup]?
    /// The agents you can call here. Absent from an older Worker.
    let agents: [ChatAgent]?
}

/// An agent as a message carries it: who wrote the reply.
struct ChatAgentFace: Codable, Hashable {
    let id: String
    let handle: String
    let name: String
    let emoji: String?

    var glyph: String { ChatAgent.glyph(emoji) }
}

/// An agent the team wrote: "@hayao" answers as its Markdown instructions
/// say. The overview sends only who it is; `/channels/agents` sends the
/// rest — its instructions, who made it, what you may do to it, the file.
struct ChatAgent: Codable, Identifiable, Hashable {
    let id: String
    let handle: String
    let name: String
    let emoji: String?
    let description: String?
    /// "team" (anyone may call and improve it) or "personal" (only yours).
    let scope: String?
    let instructions: String?
    let preset: String?
    let createdBy: String?
    let createdByName: String?
    let mine: Bool?
    let updatedByName: String?
    let updatedAt: String?
    let canEdit: Bool?
    let canDelete: Bool?
    /// The agent as a .md file: front matter, then its instructions.
    let markdown: String?

    var isPersonal: Bool { scope == "personal" }
    var glyph: String { Self.glyph(emoji) }
    static func glyph(_ emoji: String?) -> String {
        guard let e = emoji?.trimmingCharacters(in: .whitespaces), !e.isEmpty else { return "🤖" }
        return e
    }
}

/// An agent most teams want, to add and then change.
struct ChatAgentPreset: Codable, Identifiable, Hashable {
    let id: String
    let handle: String
    let emoji: String?
    let name: String
    let description: String
    let instructions: String
}

struct ChatActivityItem: Codable, Identifiable, Hashable {
    let type: String
    let message: ChatMessage
    var unread: Bool
    /// For a keyword: which of yours was said.
    var keyword: String?
    var id: String { "\(type)-\(message.id)" }
}

/// A conversation's shared document.
struct ChatCanvas: Codable, Hashable {
    let body: String
    let version: Int
    let updatedBy: String?
    let updatedAt: String?
}

struct ChatCanvasRevision: Codable, Hashable, Identifiable {
    let version: Int
    let updatedBy: String?
    let updatedAt: String
    var id: Int { version }
}

/// A link kept at the top of a conversation.
struct ChatBookmark: Codable, Identifiable, Hashable {
    let id: String
    let title: String
    let url: String
    let addedBy: String?
    let mine: Bool
}

/// One place this account is signed in.
struct SignedInSession: Codable, Identifiable, Hashable {
    let ref: String
    let client: String?
    let device: String
    /// "iphone" / "ipad" for the app; otherwise the browser and the system,
    /// each a proper name, for a sentence in the reader's language.
    var app: String?
    var browser: String?
    var os: String?
    let place: String?
    let createdAt: String
    let lastSeenAt: String
    let current: Bool
    var id: String { ref }
}

/// A thread you are in, for Threads: its first message, the last replies.
struct ChatThreadItem: Codable, Identifiable, Hashable {
    let parent: ChatMessage
    let replies: [ChatMessage]
    let replyCount: Int
    let lastReplyAt: String
    var unread: Bool
    var id: String { parent.id }
}

/// A user group: "@handle" names everyone in it.
struct ChatUserGroup: Codable, Identifiable, Hashable {
    let handle: String
    let name: String
    let refs: [String]
    var id: String { handle }
}

/// Your own sidebar: starred conversations and sections you made.
struct ChatSidebar: Codable, Hashable {
    struct Section: Codable, Hashable, Identifiable {
        let id: String
        var name: String
        var views: [String]
    }
    var starred: [String] = []
    var sections: [Section] = []
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
            SessionPolicy.noticeIfEnded(status: http.statusCode, data: data)
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

    /// Links kept at the top of a conversation.
    static func bookmarks(orgId: String, channel: String, base: URL) async throws -> [ChatBookmark] {
        struct R: Decodable { let bookmarks: [ChatBookmark] }
        return try await call("GET", "/channels/bookmarks", base: base, query: ["orgId": orgId, "channel": channel], as: R.self).bookmarks
    }

    static func addBookmark(orgId: String, channel: String, url: String, title: String, base: URL) async throws -> [ChatBookmark] {
        struct R: Decodable { let bookmarks: [ChatBookmark] }
        return try await call("POST", "/channels/bookmarks", base: base, body: ["orgId": orgId, "channel": channel, "url": url, "title": title], as: R.self).bookmarks
    }

    static func removeBookmark(orgId: String, channel: String, id: String, base: URL) async throws -> [ChatBookmark] {
        struct R: Decodable { let bookmarks: [ChatBookmark] }
        return try await call("DELETE", "/channels/bookmarks", base: base, body: ["orgId": orgId, "channel": channel, "id": id], as: R.self).bookmarks
    }

    /// A conversation's canvas, and its earlier versions.
    static func canvas(orgId: String, channel: String, base: URL) async throws -> (ChatCanvas, [ChatCanvasRevision]) {
        struct R: Decodable { let canvas: ChatCanvas; let revisions: [ChatCanvasRevision]? }
        let r = try await call("GET", "/channels/canvas", base: base, query: ["orgId": orgId, "channel": channel], as: R.self)
        return (r.canvas, r.revisions ?? [])
    }

    enum CanvasSave { case saved(ChatCanvas), conflict(ChatCanvas) }

    /// Save a version made from `baseVersion`. Somebody else's newer one
    /// comes back as a conflict rather than being written over.
    static func saveCanvas(orgId: String, channel: String, body: String, baseVersion: Int, base: URL) async throws -> CanvasSave {
        struct R: Decodable { let canvas: ChatCanvas }
        do {
            return .saved(try await call("PUT", "/channels/canvas", base: base, body: ["orgId": orgId, "channel": channel, "body": body, "baseVersion": baseVersion], as: R.self).canvas)
        } catch Failure.server(409, _) {
            let (theirs, _) = try await canvas(orgId: orgId, channel: channel, base: base)
            return .conflict(theirs)
        }
    }

    /// Your AI's proposed update from the conversation; not saved.
    static func draftCanvas(orgId: String, channel: String, body: String, base: URL) async throws -> (body: String, note: String?, byModel: Bool) {
        struct R: Decodable { let body: String; let note: String?; let byModel: Bool }
        let r = try await call("POST", "/channels/canvas/draft", base: base, body: ["orgId": orgId, "channel": channel, "body": body], as: R.self)
        return (r.body, r.note, r.byModel)
    }

    /// Where this account is signed in, this device first.
    static func sessions(base: URL) async throws -> [SignedInSession] {
        struct R: Decodable { let sessions: [SignedInSession] }
        return try await call("GET", "/sessions", base: base, as: R.self).sessions
    }

    /// Sign out one other session (`ref`), or every other one.
    static func endSessions(ref: String?, base: URL) async throws -> [SignedInSession] {
        struct R: Decodable { let sessions: [SignedInSession] }
        let body: [String: Any] = ref.map { ["ref": $0] } ?? ["others": true]
        return try await call("DELETE", "/sessions", base: base, body: body, as: R.self).sessions
    }

    /// This workspace's own emoji. Another workspace's are not in it.
    static func emoji(orgId: String, base: URL) async throws -> [ChatEmoji] {
        struct R: Decodable { let emoji: [ChatEmoji] }
        return try await call("GET", "/emoji", base: base, query: ["orgId": orgId], as: R.self).emoji
    }

    /// A group DM with these people (refs, not counting you): the same
    /// people always land in the same one.
    static func startGroup(orgId: String, refs: [String], base: URL) async throws -> String {
        struct R: Decodable { let view: String }
        return try await call("POST", "/channels/groups", base: base, body: ["orgId": orgId, "refs": refs], as: R.self).view
    }

    /// A picture or a file, uploaded into a conversation before the message
    /// that carries it is sent. The bytes are the body.
    static func upload(orgId: String, channel: String, data: Data, type: String, name: String, width: Int? = nil, height: Int? = nil, base: URL) async throws -> ChatFile {
        guard let token = SessionStore.sessionToken else { throw Failure.notSignedIn }
        var components = URLComponents(url: base, resolvingAgainstBaseURL: true)
        components?.path = "/channels/files"
        var q = [URLQueryItem(name: "orgId", value: orgId), URLQueryItem(name: "channel", value: channel), URLQueryItem(name: "name", value: name)]
        if let width { q.append(URLQueryItem(name: "width", value: String(width))) }
        if let height { q.append(URLQueryItem(name: "height", value: String(height))) }
        components?.queryItems = q
        guard let url = components?.url else { throw Failure.server(0, nil) }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 120
        request.setValue(token, forHTTPHeaderField: "x-session-token")
        request.setValue(type, forHTTPHeaderField: "Content-Type")
        let (body, response) = try await URLSession.shared.upload(for: request, from: data)
        guard let http = response as? HTTPURLResponse else { throw Failure.server(0, nil) }
        guard (200...299).contains(http.statusCode) else {
            if http.statusCode == 401 { throw Failure.notSignedIn }
            throw Failure.server(http.statusCode, (try? JSONDecoder().decode(Message.self, from: body))?.message)
        }
        struct R: Decodable { let file: ChatFile }
        return try JSONDecoder().decode(R.self, from: body).file
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

    static func send(orgId: String, channel: String, body: String, decide: Bool = false, parentId: String? = nil, sendAt: Date? = nil, files: [String] = [], base: URL) async throws -> Sent {
        var b: [String: Any] = ["orgId": orgId, "channel": channel, "body": body, "decide": decide]
        if let parentId { b["parentId"] = parentId }
        if !files.isEmpty { b["files"] = files }
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

    static func threads(orgId: String, base: URL) async throws -> [ChatThreadItem] {
        struct R: Decodable { let threads: [ChatThreadItem] }
        return try await call("GET", "/channels/threads", base: base, query: ["orgId": orgId], as: R.self).threads
    }

    static func markThreadRead(orgId: String, channel: String, parentId: String, base: URL) async {
        struct R: Decodable { let lastReadAt: String? }
        _ = try? await call("POST", "/channels/read", base: base, body: ["orgId": orgId, "channel": channel, "thread": parentId], as: R.self)
    }

    /// Unread from this message on, everywhere. Returns the thread it is in,
    /// when it is a reply.
    struct Unread: Decodable { let lastReadAt: String; let thread: String? }
    static func markUnread(orgId: String, channel: String, messageId: String, base: URL) async throws -> Unread {
        try await call("POST", "/channels/unread", base: base, body: ["orgId": orgId, "channel": channel, "messageId": messageId], as: Unread.self)
    }

    static func userGroups(orgId: String, base: URL) async throws -> [ChatUserGroup] {
        struct R: Decodable { let groups: [ChatUserGroup] }
        return try await call("GET", "/channels/usergroups", base: base, query: ["orgId": orgId], as: R.self).groups
    }

    static func sidebar(orgId: String, base: URL) async throws -> ChatSidebar {
        struct R: Decodable { let sidebar: ChatSidebar }
        return try await call("GET", "/channels/sidebar", base: base, query: ["orgId": orgId], as: R.self).sidebar
    }

    static func saveSidebar(orgId: String, sidebar: ChatSidebar, base: URL) async throws -> ChatSidebar {
        struct R: Decodable { let sidebar: ChatSidebar }
        let body: [String: Any] = [
            "orgId": orgId,
            "sidebar": [
                "starred": sidebar.starred,
                "sections": sidebar.sections.map { ["id": $0.id, "name": $0.name, "views": $0.views] as [String: Any] },
            ] as [String: Any],
        ]
        return try await call("PUT", "/channels/sidebar", base: base, body: body, as: R.self).sidebar
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

    // MARK: Agents

    struct Agents: Decodable {
        let agents: [ChatAgent]
        let presets: [ChatAgentPreset]?
    }
    struct AgentSaved: Decodable {
        let agent: ChatAgent?
        let agents: [ChatAgent]
    }

    /// The agents you may call here, and the presets to start one from.
    static func agents(orgId: String, locale: String? = nil, base: URL) async throws -> Agents {
        var q = ["orgId": orgId]
        if let locale { q["locale"] = locale }
        return try await call("GET", "/channels/agents", base: base, query: q, as: Agents.self)
    }

    /// A new agent, from the form.
    static func createAgent(orgId: String, name: String, handle: String, emoji: String, description: String, instructions: String, scope: String, preset: String? = nil, base: URL) async throws -> AgentSaved {
        var b: [String: Any] = [
            "orgId": orgId, "name": name, "handle": handle, "emoji": emoji,
            "description": description, "instructions": instructions, "scope": scope,
        ]
        if let preset { b["preset"] = preset }
        return try await call("POST", "/channels/agents", base: base, body: b, as: AgentSaved.self)
    }

    /// A new agent, from a .md file; the file says who it is.
    static func createAgent(fromMarkdown markdown: String, scope: String? = nil, orgId: String, base: URL) async throws -> AgentSaved {
        var b: [String: Any] = ["orgId": orgId, "markdown": markdown]
        if let scope { b["scope"] = scope }
        return try await call("POST", "/channels/agents", base: base, body: b, as: AgentSaved.self)
    }

    static func updateAgent(orgId: String, id: String, name: String, handle: String, emoji: String, description: String, instructions: String, scope: String, base: URL) async throws -> AgentSaved {
        let b: [String: Any] = [
            "orgId": orgId, "id": id, "name": name, "handle": handle, "emoji": emoji,
            "description": description, "instructions": instructions, "scope": scope,
        ]
        return try await call("PUT", "/channels/agents", base: base, body: b, as: AgentSaved.self)
    }

    static func deleteAgent(orgId: String, id: String, base: URL) async throws -> [ChatAgent] {
        struct R: Decodable { let agents: [ChatAgent] }
        return try await call("DELETE", "/channels/agents", base: base, body: ["orgId": orgId, "id": id], as: R.self).agents
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
