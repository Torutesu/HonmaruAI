import Foundation

enum CardServiceError: LocalizedError {
    case githubSyncFailed(String)
    case cardNotFound

    var errorDescription: String? {
        switch self {
        case .githubSyncFailed(let message): message
        case .cardNotFound: "Card not found."
        }
    }
}

@MainActor
final class DecisionCardService: ObservableObject {
    private var cardsByUser: [String: [DecisionCard]] = [:]
    private weak var webSocketService: WebSocketService?

    var onCardsUpdated: (() -> Void)?

    func attach(webSocketService: WebSocketService) {
        self.webSocketService = webSocketService
        webSocketService.onEvent = { [weak self] event in
            self?.handle(event)
        }
    }

    func applySnapshot(_ cardsByUser: [String: [DecisionCard]]) {
        self.cardsByUser = cardsByUser
        onCardsUpdated?()
    }

    func bootstrap(for user: User) {
        if cardsByUser.isEmpty {
            cardsByUser = DemoData.initialCards
        }
        onCardsUpdated?()
    }

    func cards(for userID: String) -> [DecisionCard] {
        cardsByUser[userID, default: []].sorted { $0.createdAt > $1.createdAt }
    }

    @discardableResult
    func resolve(
        cardID: String,
        action: CardActionKind,
        actorUserID: String,
        revisionNote: String? = nil,
        githubService: GitHubService
    ) async throws -> DecisionCard {
        guard var userCards = cardsByUser[actorUserID],
              let index = userCards.firstIndex(where: { $0.id == cardID }) else {
            throw CardServiceError.cardNotFound
        }

        var card = userCards[index]
        guard card.isPending else { return card }

        switch action {
        case .createIssue: card.status = .approved
        case .reject: card.status = .rejected
        case .requestRevision: card.status = .revised
        case .delegate:
            return card
        case .viewDetails:
            return card
        }

        if let revisionNote, !revisionNote.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            card.revisionNote = revisionNote.trimmingCharacters(in: .whitespacesAndNewlines)
            card.context = [card.context, "Revision: \(card.revisionNote!)"].filter { !$0.isEmpty }.joined(separator: "\n")
        }

        let synced = try await githubService.syncDecision(card)
        card.githubIssueNumber = synced.number
        card.githubIssueURL = synced.url

        userCards[index] = card
        cardsByUser[actorUserID] = userCards
        await webSocketService?.publishUpdated(card)

        let statusLabel: String = {
            switch card.status {
            case .approved: "created GitHub issue"
            case .rejected: "declined"
            case .revised: "requested revision"
            default: card.status.label.lowercased()
            }
        }()

        let responseCard = DecisionCard(
            id: UUID().uuidString,
            recipientUserID: card.senderUserID,
            senderUserID: actorUserID,
            type: .notification,
            title: card.title,
            summary: "\(DemoData.userName(for: actorUserID)) · \(statusLabel)",
            context: card.revisionNote ?? card.summary,
            status: .pending,
            priority: .medium,
            createdAt: .now,
            githubIssueNumber: synced.number,
            githubIssueURL: synced.url,
            agentRoute: card.agentRoute,
            routingReason: card.routingReason
        )

        append(responseCard, for: card.senderUserID)
        await webSocketService?.publishCreated(responseCard)
        onCardsUpdated?()
        return card
    }

    @discardableResult
    func delegate(
        cardID: String,
        to recipientUserID: String,
        actorUserID: String,
        organization: OrganizationGraph,
        githubService: GitHubService
    ) async throws -> DecisionCard {
        guard var userCards = cardsByUser[actorUserID],
              let index = userCards.firstIndex(where: { $0.id == cardID }) else {
            throw CardServiceError.cardNotFound
        }

        var card = userCards[index]
        guard card.isPending else { return card }
        guard recipientUserID != actorUserID else {
            throw CardServiceError.githubSyncFailed("Pick someone else to delegate to.")
        }

        card.status = .delegated
        let synced = try await githubService.syncDecision(card)
        card.githubIssueNumber = synced.number
        card.githubIssueURL = synced.url

        userCards[index] = card
        cardsByUser[actorUserID] = userCards
        await webSocketService?.publishUpdated(card)

        let actorName = DemoData.userName(for: actorUserID)
        let recipientName = DemoData.userName(for: recipientUserID)
        let delegatedCard = DecisionCard(
            id: UUID().uuidString,
            recipientUserID: recipientUserID,
            senderUserID: actorUserID,
            type: .delegation,
            title: card.title,
            summary: card.summary,
            context: "Delegated by \(actorName) · \(card.context)",
            status: .pending,
            priority: card.priority,
            createdAt: .now,
            githubIssueNumber: synced.number,
            githubIssueURL: synced.url,
            agentRoute: "\(actorName)'s AI → \(recipientName)'s AI",
            routingReason: "Delegated by \(actorName)"
        )

        append(delegatedCard, for: recipientUserID)
        await webSocketService?.publishCreated(delegatedCard)

        let responseCard = DecisionCard(
            id: UUID().uuidString,
            recipientUserID: card.senderUserID,
            senderUserID: actorUserID,
            type: .notification,
            title: card.title,
            summary: "\(actorName) delegated to \(recipientName)",
            context: card.summary,
            status: .pending,
            priority: .medium,
            createdAt: .now,
            githubIssueNumber: synced.number,
            githubIssueURL: synced.url,
            agentRoute: delegatedCard.agentRoute,
            routingReason: "Delegation update"
        )

        append(responseCard, for: card.senderUserID)
        await webSocketService?.publishCreated(responseCard)
        onCardsUpdated?()
        return card
    }

    func processInstruction(
        _ text: String,
        from sender: User,
        organization: OrganizationGraph,
        aiService: AIService,
        priorityOverride: CardPriority? = nil
    ) async throws -> DecisionCard {
        let routing: InstructionRouting
        if aiService.isConfigured {
            do {
                routing = try await aiService.routeInstruction(
                    text: text,
                    sender: sender,
                    organization: organization,
                    priorityOverride: priorityOverride
                )
            } catch {
                routing = InstructionRouter.route(text: text, sender: sender, organization: organization)
            }
        } else {
            routing = InstructionRouter.route(text: text, sender: sender, organization: organization)
        }

        let card = DecisionCard(
            id: UUID().uuidString,
            recipientUserID: routing.recipientID,
            senderUserID: sender.id,
            type: routing.cardType,
            title: routing.title,
            summary: routing.summary,
            context: routing.context,
            status: .pending,
            priority: routing.priority,
            createdAt: .now,
            githubIssueNumber: nil,
            githubIssueURL: nil,
            agentRoute: routing.agentRoute,
            routingReason: routing.routingReason,
            sourceInstruction: text,
            labels: routing.labels.isEmpty ? nil : routing.labels
        )

        append(card, for: routing.recipientID)
        await webSocketService?.publishCreated(card)
        onCardsUpdated?()
        return card
    }

    @discardableResult
    func processRouting(
        _ routing: InstructionRouting,
        sourceText: String,
        from sender: User
    ) async throws -> DecisionCard {
        let card = DecisionCard(
            id: UUID().uuidString,
            recipientUserID: routing.recipientID,
            senderUserID: sender.id,
            type: routing.cardType,
            title: routing.title,
            summary: routing.summary,
            context: routing.context,
            status: .pending,
            priority: routing.priority,
            createdAt: .now,
            githubIssueNumber: nil,
            githubIssueURL: nil,
            agentRoute: routing.agentRoute,
            routingReason: routing.routingReason,
            sourceInstruction: sourceText,
            labels: routing.labels.isEmpty ? nil : routing.labels
        )

        append(card, for: routing.recipientID)
        await webSocketService?.publishCreated(card)
        onCardsUpdated?()
        return card
    }

    private func handle(_ event: RealtimeEvent) {
        switch event {
        case .snapshot(let cardsByUser):
            applySnapshot(cardsByUser)
        case .cardCreated(let card):
            upsert(card)
        case .cardUpdated(let card):
            upsert(card)
        case .presence, .error:
            break
        }
    }

    private func upsert(_ card: DecisionCard) {
        var cards = cardsByUser[card.recipientUserID, default: []]
        if let index = cards.firstIndex(where: { $0.id == card.id }) {
            cards[index] = card
        } else {
            cards.insert(card, at: 0)
        }
        cardsByUser[card.recipientUserID] = cards
        onCardsUpdated?()
    }

    private func append(_ card: DecisionCard, for userID: String) {
        var cards = cardsByUser[userID, default: []]
        cards.insert(card, at: 0)
        cardsByUser[userID] = cards
    }
}
