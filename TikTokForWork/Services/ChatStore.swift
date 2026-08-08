import Foundation

/// Channels, messages and unread counts for the Classic surface.
///
/// Everything is in memory. Classic exists to show the shape of the old way of
/// working, and tying it to the relay would mean the comparison stops working
/// exactly when the network does.
@MainActor
final class ChatStore: ObservableObject {
    @Published private(set) var channels: [ChatChannel] = []
    @Published private(set) var messagesByChannel: [String: [ChatMessage]] = [:]
    @Published private(set) var readAt: [String: Date] = [:]

    /// Where a decision lands when it is made on a card. Naming it after the
    /// work rather than the tool keeps the two surfaces talking about the same
    /// thing.
    static let decisionsChannelID = "channel-decisions"

    init() {
        seed()
    }

    // MARK: - Reading

    func messages(in channelID: String) -> [ChatMessage] {
        (messagesByChannel[channelID] ?? []).sorted { $0.sentAt < $1.sentAt }
    }

    func lastMessage(in channelID: String) -> ChatMessage? {
        messages(in: channelID).last
    }

    /// Unread means "arrived after you last looked", which is the only
    /// definition that survives you leaving and coming back.
    func unreadCount(in channelID: String) -> Int {
        let since = readAt[channelID] ?? .distantPast
        return messages(in: channelID).filter { $0.sentAt > since && !$0.isOwn }.count
    }

    func channels(of kind: ChatChannel.Kind) -> [ChatChannel] {
        channels.filter { $0.kind == kind }
    }

    // MARK: - Writing

    func markRead(_ channelID: String) {
        readAt[channelID] = .now
    }

    func send(_ body: String, to channelID: String, author: String) {
        let trimmed = body.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        append(ChatMessage(
            channelID: channelID,
            authorName: author,
            body: trimmed,
            sentAt: .now
        ))
        markRead(channelID)
    }

    /// Mirrors a decision card into the channel it belongs to, so a card that
    /// arrives is visible from both surfaces rather than only the one you happen
    /// to be looking at.
    func announce(_ card: DecisionCard) {
        let channelID = Self.decisionsChannelID
        guard !messages(in: channelID).contains(where: { $0.decisionCardID == card.id }) else { return }
        append(ChatMessage(
            channelID: channelID,
            authorName: card.senderName,
            body: "\(card.title)\n\(card.summary)",
            sentAt: card.createdAt,
            isApp: true,
            decisionCardID: card.id
        ))
    }

    /// Records what was decided. This is the half the Classic surface was
    /// missing: acting on a card left no trace here, so the two views disagreed.
    func recordDecision(_ card: DecisionCard, action: CardActionKind, by author: String) {
        let verb: String
        switch action {
        case .createIssue:      verb = String(localized: "approved this")
        case .reject:           verb = String(localized: "declined this")
        case .requestRevision:  verb = String(localized: "asked for changes")
        case .delegate:         verb = String(localized: "delegated this")
        case .delete, .viewDetails: return
        }

        append(ChatMessage(
            channelID: Self.decisionsChannelID,
            authorName: author,
            body: "\(verb) — \(card.title)",
            sentAt: .now,
            decisionCardID: card.id
        ))
        markRead(Self.decisionsChannelID)
    }

    private func append(_ message: ChatMessage) {
        messagesByChannel[message.channelID, default: []].append(message)
    }

    // MARK: - Seed

    /// The conversation texture from `docs/figma/classic-slack-rebuild.js`, now
    /// backed by real messages you can open and reply to.
    private func seed() {
        let now = Date.now
        func ago(_ minutes: Double) -> Date { now.addingTimeInterval(-minutes * 60) }

        channels = [
            ChatChannel(id: Self.decisionsChannelID, name: "decisions", kind: .channel),
            ChatChannel(id: "channel-north", name: "north-inc", kind: .channel),
            ChatChannel(id: "channel-general", name: "general", kind: .channel),
            ChatChannel(id: "dm-tanaka", name: "田中", kind: .directMessage, tint: 0xE8912D, isOnline: true),
            ChatChannel(id: "dm-yui", name: "結衣", kind: .directMessage, tint: 0x7C3085, isOnline: true),
            ChatChannel(id: "dm-alex", name: "Alex", kind: .directMessage, tint: 0x2BAC76, isOnline: true),
            ChatChannel(id: "app-freee", name: "freee", kind: .app, tint: 0x1D1C1D),
            ChatChannel(id: "app-notion", name: "Notion", kind: .app, tint: 0x616061),
            ChatChannel(id: "app-gmail", name: "Gmail", kind: .app, tint: 0xEA4335),
            ChatChannel(id: "app-calendar", name: "Google Calendar", kind: .app, tint: 0x4285F4),
        ]

        let seeded: [ChatMessage] = [
            .init(channelID: "channel-north", authorName: "田中",
                  body: "ヒーロー画像、やっぱり別案も見てみたいです。金曜までに難しいですか？", sentAt: ago(12)),
            .init(channelID: "channel-north", authorName: "結衣",
                  body: "差し替えだけなら2日あればできます。工数は別途で。", sentAt: ago(8)),
            .init(channelID: "channel-general", authorName: "結衣",
                  body: "来週火曜は終日打ち合わせで動けません", sentAt: ago(60 * 26)),
            .init(channelID: "dm-tanaka", authorName: "田中",
                  body: "請求書、月末締めでお願いできますか", sentAt: ago(45)),
            .init(channelID: "dm-yui", authorName: "結衣",
                  body: "ロゴ3案、フォルダに入れました。確認おねがいします", sentAt: ago(180)),
            // Left in English on purpose. Classic is where you read what people
            // actually wrote; the card is where you do not have to.
            .init(channelID: "dm-alex", authorName: "Alex",
                  body: "Rebuild is done and staging looks clean. I'd like to push to production tonight while their traffic is low — otherwise the next safe window is Monday. Need your go by 22:00 my time.",
                  sentAt: ago(14)),
            .init(channelID: "dm-alex", authorName: "Alex",
                  body: "Also: there's a booking form on the old site that wasn't in the spec. Rebuilding it properly is ~3 days. Quote it, or leave it out?",
                  sentAt: ago(180)),
            .init(channelID: "channel-north", authorName: "Alex",
                  body: "Staging is up: https://staging.north.example — please check the contact page, the old one had a hardcoded address.",
                  sentAt: ago(200)),
            .init(channelID: "app-freee", authorName: "freee",
                  body: "入金確認: ノース社 ¥180,000 は未入金のままです（期日 14日超過）", sentAt: ago(90), isApp: true),
            .init(channelID: "app-gmail", authorName: "Gmail",
                  body: "新着: 「Web制作のお見積もりについて」— 株式会社サウス 佐藤様（未読 2件）", sentAt: ago(35), isApp: true),
            .init(channelID: "app-gmail", authorName: "Gmail",
                  body: "新着: 「契約延長のご相談」— ノース社 田中様", sentAt: ago(95), isApp: true),
            .init(channelID: "app-calendar", authorName: "Google Calendar",
                  body: "明日 15:00 ノース社 定例（30分）· 参加者: 田中, あなた", sentAt: ago(120), isApp: true),
            .init(channelID: "app-calendar", authorName: "Google Calendar",
                  body: "結衣さんの稼働枠が水曜まで空いています", sentAt: ago(420), isApp: true),
            .init(channelID: "app-notion", authorName: "Notion",
                  body: "「Q3の受注計画」が更新されました — 単価改定の項目が追加", sentAt: ago(150), isApp: true),
        ]
        for message in seeded { append(message) }

        // Everything before now is unread except the channel you were last in.
        readAt["channel-general"] = .now
    }
}

private extension ChatMessage {
    /// Your own messages never count as unread.
    var isOwn: Bool {
        authorName == DemoUser.toru.displayName
    }
}
