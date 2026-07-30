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
        webSocketService.addEventHandler { [weak self] event in
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

    func reset() {
        cardsByUser = [:]
        onCardsUpdated?()
    }

    func syncGitHubStatus(githubService: GitHubService) async {
        guard githubService.isConnected else { return }

        var changed = false
        for (userID, var userCards) in cardsByUser {
            var userChanged = false

            for index in userCards.indices {
                guard let issueNumber = userCards[index].githubIssueNumber else { continue }
                guard userCards[index].githubRepository == githubService.linkedRepository else { continue }

                let status = userCards[index].status
                guard status == .approved || status == .completed || status == .delegated else {
                    continue
                }

                do {
                    let issueState = try await githubService.issueState(number: issueNumber)
                    if issueState == "closed", status != .completed {
                        userCards[index].status = .completed
                        userChanged = true
                        await webSocketService?.publishUpdated(userCards[index])
                    } else if issueState == "open", status == .completed {
                        userCards[index].status = .approved
                        userChanged = true
                        await webSocketService?.publishUpdated(userCards[index])
                    }
                } catch {
                    continue
                }
            }

            if userChanged {
                cardsByUser[userID] = userCards
                changed = true
            }
        }

        if changed {
            onCardsUpdated?()
        }
    }

    func cards(for userID: String) -> [DecisionCard] {
        cardsByUser[userID, default: []].sorted { $0.createdAt > $1.createdAt }
    }

    @discardableResult
    func resolve(
        cardID: String,
        action: CardActionKind,
        actorUserID: String,
        note: String? = nil,
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
        case .delegate, .delete, .viewDetails, .askAI, .reviseResend, .reply, .acknowledge:
            return card
        }

        let trimmedNote = note?.trimmingCharacters(in: .whitespacesAndNewlines)
        let decisionNote = (trimmedNote?.isEmpty == false) ? trimmedNote : nil
        if let decisionNote {
            switch action {
            case .requestRevision:
                card.revisionNote = decisionNote
                card.context = [card.context, "Revision: \(decisionNote)"]
                    .filter { !$0.isEmpty }.joined(separator: "\n")
            case .createIssue:
                card.context = [card.context, "Condition: \(decisionNote)"]
                    .filter { !$0.isEmpty }.joined(separator: "\n")
            case .reject:
                card.context = [card.context, "Reason: \(decisionNote)"]
                    .filter { !$0.isEmpty }.joined(separator: "\n")
            default:
                break
            }
        }

        if action == .createIssue || card.githubIssueNumber != nil {
            let synced = try await githubService.syncDecision(card)
            card.githubIssueNumber = synced.number
            card.githubIssueURL = synced.url
            card.githubRepository = githubService.linkedRepository
        }

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

        // A revision request goes back as an actionable card the sender can
        // revise and resend; other outcomes are plain notifications.
        let isRevisionRequest = card.status == .revised
        let responseCard = DecisionCard(
            id: UUID().uuidString,
            recipientUserID: card.senderUserID,
            senderUserID: actorUserID,
            type: isRevisionRequest ? .revision : .notification,
            title: card.title,
            summary: "\(DemoData.userName(for: actorUserID)) · \(statusLabel)",
            context: decisionNote ?? card.summary,
            status: .pending,
            priority: isRevisionRequest ? card.priority : .medium,
            createdAt: .now,
            githubIssueNumber: card.githubIssueNumber,
            githubIssueURL: card.githubIssueURL,
            agentRoute: card.agentRoute,
            routingReason: isRevisionRequest
                ? "\(DemoData.userName(for: actorUserID)) asked for changes — revise and resend"
                : card.routingReason,
            sourceInstruction: card.sourceInstruction ?? card.summary,
            revisionNote: isRevisionRequest ? card.revisionNote : nil,
            channelID: card.channelID
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
        card.githubRepository = githubService.linkedRepository

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
            githubRepository: githubService.linkedRepository,
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
            githubRepository: githubService.linkedRepository,
            agentRoute: delegatedCard.agentRoute,
            routingReason: "Delegation update"
        )

        append(responseCard, for: card.senderUserID)
        await webSocketService?.publishCreated(responseCard)
        onCardsUpdated?()
        return card
    }

    @discardableResult
    func setPriority(cardID: String, to priority: CardPriority, actorUserID: String) async throws -> DecisionCard {
        guard var userCards = cardsByUser[actorUserID],
              let index = userCards.firstIndex(where: { $0.id == cardID }) else {
            throw CardServiceError.cardNotFound
        }

        var card = userCards[index]
        guard card.priority != priority else { return card }

        card.priority = priority
        userCards[index] = card
        cardsByUser[actorUserID] = userCards
        await webSocketService?.publishUpdated(card)
        onCardsUpdated?()
        return card
    }

    @discardableResult
    func applyRefinement(
        _ refinement: CardRefinementResult,
        cardID: String,
        actorUserID: String
    ) async throws -> DecisionCard {
        guard var userCards = cardsByUser[actorUserID],
              let index = userCards.firstIndex(where: { $0.id == cardID }) else {
            throw CardServiceError.cardNotFound
        }

        var card = userCards[index]
        card.title = refinement.title
        card.summary = refinement.summary
        card.context = refinement.context
        card.priority = refinement.priority
        userCards[index] = card
        cardsByUser[actorUserID] = userCards
        await webSocketService?.publishUpdated(card)
        onCardsUpdated?()
        return card
    }

    // Quietly close a notification card: no response card, no GitHub sync.
    @discardableResult
    func acknowledge(cardID: String, actorUserID: String) async throws -> DecisionCard {
        guard var userCards = cardsByUser[actorUserID],
              let index = userCards.firstIndex(where: { $0.id == cardID }) else {
            throw CardServiceError.cardNotFound
        }

        var card = userCards[index]
        guard card.isPending else { return card }

        card.status = .acknowledged
        userCards[index] = card
        cardsByUser[actorUserID] = userCards
        await webSocketService?.publishUpdated(card)
        onCardsUpdated?()
        return card
    }

    // A question or note about a card, sent back to its sender as a
    // lightweight notification card. The original card stays pending.
    func sendReplyCard(
        about card: DecisionCard,
        isQuestion: Bool,
        note: String,
        actorUserID: String
    ) async {
        let actorName = DemoData.userName(for: actorUserID)
        let recipientName = DemoData.userName(for: card.senderUserID)

        let replyCard = DecisionCard(
            id: UUID().uuidString,
            recipientUserID: card.senderUserID,
            senderUserID: actorUserID,
            type: .notification,
            title: "\(isQuestion ? "Question" : "Note"): \(card.title)",
            summary: note,
            context: "About: \(card.summary)",
            status: .pending,
            priority: isQuestion ? card.priority : .medium,
            createdAt: .now,
            agentRoute: "\(actorName)'s AI → \(recipientName)'s AI",
            routingReason: isQuestion
                ? "\(actorName) needs an answer before deciding"
                : "\(actorName) left a note on your request",
            sourceInstruction: card.sourceInstruction,
            channelID: card.channelID
        )

        append(replyCard, for: card.senderUserID)
        await webSocketService?.publishCreated(replyCard)
        onCardsUpdated?()
    }

    func markResent(cardID: String, actorUserID: String) async {
        guard var userCards = cardsByUser[actorUserID],
              let index = userCards.firstIndex(where: { $0.id == cardID }) else {
            return
        }

        userCards[index].status = .resent
        cardsByUser[actorUserID] = userCards
        await webSocketService?.publishUpdated(userCards[index])
        onCardsUpdated?()
    }

    func delete(cardID: String, actorUserID: String) async throws {
        guard var userCards = cardsByUser[actorUserID],
              let index = userCards.firstIndex(where: { $0.id == cardID }) else {
            throw CardServiceError.cardNotFound
        }

        let card = userCards[index]
        guard card.canDelete else {
            throw CardServiceError.githubSyncFailed("Only declined cards can be deleted.")
        }

        userCards.remove(at: index)
        cardsByUser[actorUserID] = userCards
        await webSocketService?.publishDeleted(cardID: cardID, recipientUserID: actorUserID)
        onCardsUpdated?()
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
            labels: routing.labels.isEmpty ? nil : routing.labels,
            channelID: routing.channelID
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
        case .cardDeleted(let cardID, let recipientUserID):
            remove(cardID: cardID, for: recipientUserID)
        case .presence, .error, .channelSnapshot, .channelCreated, .channelMessage:
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

    private func remove(cardID: String, for userID: String) {
        var cards = cardsByUser[userID, default: []]
        cards.removeAll { $0.id == cardID }
        cardsByUser[userID] = cards
        onCardsUpdated?()
    }
}
