import Foundation

/// The Classic surface's data. Local by design: it stands in for the old way of
/// working, and a demo of "the old way" must not depend on a relay being up.
struct ChatChannel: Identifiable, Hashable {
    enum Kind {
        case channel
        case directMessage
        case app
    }

    let id: String
    let name: String
    let kind: Kind
    /// Colour of the avatar square for DMs and apps; channels use a `#` glyph.
    let tint: UInt?
    let isOnline: Bool

    init(id: String, name: String, kind: Kind, tint: UInt? = nil, isOnline: Bool = false) {
        self.id = id
        self.name = name
        self.kind = kind
        self.tint = tint
        self.isOnline = isOnline
    }
}

struct ChatMessage: Identifiable, Hashable {
    let id: String
    let channelID: String
    let authorName: String
    let body: String
    let sentAt: Date
    /// Agents and integrations get the `APP` tag Slack puts on bot messages.
    let isApp: Bool
    /// Set when this message is the record of a decision, so the Classic
    /// surface can show what happened on the card without duplicating it.
    let decisionCardID: String?

    init(
        id: String = UUID().uuidString,
        channelID: String,
        authorName: String,
        body: String,
        sentAt: Date,
        isApp: Bool = false,
        decisionCardID: String? = nil
    ) {
        self.id = id
        self.channelID = channelID
        self.authorName = authorName
        self.body = body
        self.sentAt = sentAt
        self.isApp = isApp
        self.decisionCardID = decisionCardID
    }
}
