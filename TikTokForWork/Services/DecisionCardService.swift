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
        githubService: GitHubService
    ) async throws -> DecisionCard {
        guard var userCards = cardsByUser[actorUserID],
              let index = userCards.firstIndex(where: { $0.id == cardID }) else {
            throw CardServiceError.cardNotFound
        }

        var card = userCards[index]
        guard card.isPending else { return card }

        switch action {
        case .approve: card.status = .approved
        case .reject: card.status = .rejected
        case .requestRevision: card.status = .revised
        case .delegate: card.status = .delegated
        case .viewDetails: return card
        }

        let synced = try await githubService.syncDecision(card)
        card.githubIssueNumber = synced.number
        card.githubIssueURL = synced.url

        userCards[index] = card
        cardsByUser[actorUserID] = userCards
        await webSocketService?.publishUpdated(card)

        let responseCard = DecisionCard(
            id: UUID().uuidString,
            recipientUserID: card.senderUserID,
            senderUserID: actorUserID,
            type: .notification,
            title: card.title,
            summary: "\(DemoData.userName(for: actorUserID)) · \(card.status.label)",
            context: card.summary,
            status: .pending,
            priority: .medium,
            createdAt: .now,
            githubIssueNumber: synced.number,
            githubIssueURL: synced.url,
            agentRoute: card.agentRoute
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
        aiService: AIService
    ) async throws -> DecisionCard {
        let routing: InstructionRouting
        if aiService.isConfigured {
            do {
                routing = try await aiService.routeInstruction(
                    text: text,
                    sender: sender,
                    organization: organization
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
            agentRoute: routing.agentRoute
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
