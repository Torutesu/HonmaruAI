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
    private weak var webSocketService: WebSocketService?

    var currentUserID: String?
    var onCardsUpdated: (() -> Void)?
    var onError: ((String) -> Void)?

    func attach(webSocketService: WebSocketService) {
        self.webSocketService = webSocketService
        webSocketService.onEvent = { [weak self] event in
            self?.handle(event)
        }
    }

    func reset() {
        cards = [:]
        onCardsUpdated?()
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
        case .welcome(_, _, let members, let teams, let edges):
            OrgDirectory.shared.apply(members: members, teams: teams, edges: edges)

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

        case .error(_, let message):
            onError?(message)

        case .presence, .ignored:
            break
        }
    }
}
