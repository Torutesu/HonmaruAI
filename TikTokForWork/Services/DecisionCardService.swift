import Foundation

enum CardServiceError: LocalizedError {
    case notConnected
    case cardNotFound

    var errorDescription: String? {
        switch self {
        case .notConnected: "Not connected to the server."
        case .cardNotFound: "Card not found."
        }
    }
}

// Thin client-side store. The server owns routing, the card state machine,
// and integrations; this class renders the event stream and forwards
// intent (instruction / card_action) upstream.
@MainActor
final class DecisionCardService: ObservableObject {
    private(set) var cards: [String: DecisionCard] = [:]
    @Published private(set) var messagesByCard: [String: [CardMessage]] = [:]
    @Published private(set) var notifications: [NotificationItem] = []
    @Published private(set) var unreadNotifications = 0

    // Classic chat mode.
    @Published private(set) var channels: [ChatChannel] = []
    @Published private(set) var chatMessagesByChannel: [String: [ChatMessage]] = [:]
    @Published private(set) var chatUnseenByChannel: [String: Int] = [:]
    var activeChatChannelID: String?

    private weak var webSocketService: WebSocketService?

    var currentUserID: String?
    var onCardsUpdated: (() -> Void)?
    var onInboxUpdated: (() -> Void)?
    var onError: ((String) -> Void)?

    func attach(webSocketService: WebSocketService) {
        self.webSocketService = webSocketService
        webSocketService.onEvent = { [weak self] event in
            self?.handle(event)
        }
    }

    func reset() {
        cards = [:]
        messagesByCard = [:]
        notifications = []
        unreadNotifications = 0
        channels = []
        chatMessagesByChannel = [:]
        chatUnseenByChannel = [:]
        activeChatChannelID = nil
        onCardsUpdated?()
        onInboxUpdated?()
    }

    var totalChatUnseen: Int {
        chatUnseenByChannel.values.reduce(0, +)
    }

    func upsertChannel(_ channel: ChatChannel) {
        if !channels.contains(where: { $0.id == channel.id }) {
            channels.append(channel)
        }
    }

    func openChatChannel(_ channelID: String) {
        activeChatChannelID = channelID
        chatUnseenByChannel[channelID] = 0
    }

    func seedChatMessages(channelID: String, messages: [ChatMessage]) {
        var merged = messages
        for streamed in chatMessagesByChannel[channelID] ?? []
        where !merged.contains(where: { $0.id == streamed.id }) {
            merged.append(streamed)
        }
        chatMessagesByChannel[channelID] = merged.sorted { $0.createdAt < $1.createdAt }
    }

    func sendChatMessage(
        channelID: String,
        text: String,
        parentMessageID: String? = nil
    ) async throws {
        guard let webSocketService, webSocketService.isConnected else {
            throw CardServiceError.notConnected
        }
        await webSocketService.sendChatMessage(
            channelID: channelID,
            text: text,
            parentMessageID: parentMessageID
        )
    }

    // REST-fetched history merges under any messages that streamed in.
    func seedMessages(cardID: String, messages: [CardMessage]) {
        var merged = messages
        for streamed in messagesByCard[cardID] ?? [] where !merged.contains(where: { $0.id == streamed.id }) {
            merged.append(streamed)
        }
        messagesByCard[cardID] = merged.sorted { $0.createdAt < $1.createdAt }
    }

    func seedInbox(notifications: [NotificationItem], unread: Int) {
        self.notifications = notifications
        unreadNotifications = unread
        onInboxUpdated?()
    }

    func markInboxRead() {
        unreadNotifications = 0
        notifications = notifications.map { item in
            var updated = item
            if updated.readAt == nil { updated.readAt = .now }
            return updated
        }
        onInboxUpdated?()
    }

    func sendMessage(cardID: String, text: String) async throws {
        guard let webSocketService, webSocketService.isConnected else {
            throw CardServiceError.notConnected
        }
        await webSocketService.sendCardMessage(cardID: cardID, text: text)
    }

    // Feed order mirrors the server's ranking: pending first, then
    // priority weight plus waiting-time escalation.
    func cards(for userID: String) -> [DecisionCard] {
        cards.values
            .filter { $0.recipientUserID == userID || $0.senderUserID == userID }
            .sorted { score($0) > score($1) }
    }

    private func score(_ card: DecisionCard) -> Double {
        let priorityWeight: Double = switch card.priority {
        case .urgent: 400
        case .high: 200
        case .medium: 100
        case .low: 20
        }
        let ageHours = max(0, Date.now.timeIntervalSince(card.createdAt)) / 3600
        var value = priorityWeight + min(ageHours * 8, 300)
        if card.isPending { value += 10_000 }
        return value
    }

    // MARK: - Intent

    func sendInstruction(text: String, priority: CardPriority?) async throws {
        guard let webSocketService, webSocketService.isConnected else {
            throw CardServiceError.notConnected
        }
        await webSocketService.sendInstruction(text: text, priorityOverride: priority)
    }

    func send(
        action: CardActionKind,
        card: DecisionCard,
        note: String? = nil,
        delegateToUserID: String? = nil
    ) async throws {
        guard let webSocketService, webSocketService.isConnected else {
            throw CardServiceError.notConnected
        }
        let wireAction: String? = switch action {
        case .createIssue: "approve"
        case .reject: "reject"
        case .requestRevision: "request_revision"
        case .delegate: "delegate"
        case .delete: "delete"
        case .viewDetails: nil
        }
        guard let wireAction else { return }
        await webSocketService.sendCardAction(
            cardID: card.id,
            action: wireAction,
            note: note,
            delegateToUserID: delegateToUserID
        )
    }

    // MARK: - Event stream

    private func handle(_ event: RealtimeEvent) {
        switch event {
        case .welcome(_, _, let members, let teams, let edges, let welcomeChannels):
            OrgDirectory.shared.apply(members: members, teams: teams, edges: edges)
            channels = welcomeChannels

        case .snapshot(let snapshotCards):
            cards = Dictionary(uniqueKeysWithValues: snapshotCards.map { ($0.id, $0) })
            onCardsUpdated?()

        case .cardCreated(let card):
            cards[card.id] = card
            onCardsUpdated?()

        case .cardUpdated(let card, let previousRecipientUserID):
            // A re-route can move the card away from this user entirely.
            if let currentUserID,
               previousRecipientUserID == currentUserID,
               card.recipientUserID != currentUserID,
               card.senderUserID != currentUserID {
                cards[card.id] = nil
            } else {
                cards[card.id] = card
            }
            onCardsUpdated?()

        case .cardDeleted(let cardID, _, _):
            cards[cardID] = nil
            onCardsUpdated?()

        case .ack(_, let card):
            if let card {
                cards[card.id] = card
                onCardsUpdated?()
            }

        case .memberChanged(let member):
            OrgDirectory.shared.upsert(member: member)

        case .messageCreated(let message):
            var thread = messagesByCard[message.cardId] ?? []
            if !thread.contains(where: { $0.id == message.id }) {
                thread.append(message)
                messagesByCard[message.cardId] = thread
            }

        case .channelCreated(let channel):
            upsertChannel(channel)

        case .chatMessageCreated(let message):
            var thread = chatMessagesByChannel[message.channelId] ?? []
            if !thread.contains(where: { $0.id == message.id }) {
                thread.append(message)
                chatMessagesByChannel[message.channelId] = thread
                if message.channelId != activeChatChannelID,
                   message.authorUserId != currentUserID {
                    chatUnseenByChannel[message.channelId, default: 0] += 1
                }
            }

        case .notification(let item):
            notifications.insert(item, at: 0)
            unreadNotifications += 1
            onInboxUpdated?()

        case .error(_, let message):
            onError?(message)

        case .presence, .ignored:
            break
        }
    }
}
