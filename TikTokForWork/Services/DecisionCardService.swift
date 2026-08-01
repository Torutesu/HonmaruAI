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
    private let relay = RelayDecisionClient()

    var onCardsUpdated: (() -> Void)?

    func attach(webSocketService: WebSocketService) {
        self.webSocketService = webSocketService
        webSocketService.addEventHandler { [weak self] event in
            self?.handle(event)
        }
    }

    func configureRelay(baseURL: URL?, token: String?) {
        relay.configure(baseURL: baseURL, token: token)
    }

    /// The relay owns decisions whenever there is one to talk to. Without a
    /// connection the app still runs as a local demo (AppState seeds the feed
    /// when the socket won't open) — see `decideOffline`.
    private var relayOwnsDecisions: Bool {
        relay.isConfigured && webSocketService?.isConnected == true
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
        let decision: DecisionAction
        switch action {
        case .createIssue: decision = .approve
        case .reject: decision = .reject
        case .requestRevision: decision = .revise
        case .acknowledge: decision = .acknowledge
        case .delegate, .delete, .viewDetails, .askAI, .reviseResend, .reply:
            guard let existing = findCard(cardID, for: actorUserID) else {
                throw CardServiceError.cardNotFound
            }
            return existing
        }

        let decided = try await decide(
            cardID: cardID,
            action: decision,
            actorUserID: actorUserID,
            note: note
        )
        return try await syncGitHubIfNeeded(decided, githubService: githubService)
    }

    @discardableResult
    func delegate(
        cardID: String,
        to recipientUserID: String,
        actorUserID: String,
        organization: OrganizationGraph,
        githubService: GitHubService
    ) async throws -> DecisionCard {
        guard recipientUserID != actorUserID else {
            throw CardServiceError.githubSyncFailed("Pick someone else to delegate to.")
        }

        let decided = try await decide(
            cardID: cardID,
            action: .delegate,
            actorUserID: actorUserID,
            delegateToUserID: recipientUserID
        )
        return try await syncGitHubIfNeeded(decided, githubService: githubService)
    }

    @discardableResult
    func setPriority(cardID: String, to priority: CardPriority, actorUserID: String) async throws -> DecisionCard {
        guard let current = findCard(cardID, for: actorUserID) else {
            throw CardServiceError.cardNotFound
        }
        guard current.priority != priority else { return current }

        return try await decide(
            cardID: cardID,
            action: .priority,
            actorUserID: actorUserID,
            priority: priority
        )
    }

    // MARK: - Decision routing

    /// Every decision goes to the relay when there is one; the local path is
    /// the demo mode's minimum, not a second implementation of the rules.
    private func decide(
        cardID: String,
        action: DecisionAction,
        actorUserID: String,
        note: String? = nil,
        delegateToUserID: String? = nil,
        priority: CardPriority? = nil
    ) async throws -> DecisionCard {
        guard relayOwnsDecisions else {
            return try decideOffline(
                cardID: cardID,
                action: action,
                actorUserID: actorUserID,
                note: note,
                priority: priority
            )
        }

        let decided = try await relay.decide(
            cardID: cardID,
            action: action,
            actorUserID: actorUserID,
            note: note,
            delegateToUserID: delegateToUserID,
            priority: priority
        )
        // The socket delivers the same card plus any follow-ups; applying the
        // response too just makes the feed update without waiting for it.
        upsert(decided)
        return decided
    }

    /// No relay: flip the status and keep the note visible. Nothing is
    /// broadcast, nobody else can see it, and no response card is invented —
    /// the demo stays coherent without duplicating `server/decisions.js`.
    private func decideOffline(
        cardID: String,
        action: DecisionAction,
        actorUserID: String,
        note: String?,
        priority: CardPriority?
    ) throws -> DecisionCard {
        guard var userCards = cardsByUser[actorUserID],
              let index = userCards.firstIndex(where: { $0.id == cardID }) else {
            throw CardServiceError.cardNotFound
        }

        var card = userCards[index]
        if action == .priority {
            card.priority = priority ?? card.priority
        } else {
            guard card.isPending else { return card }
            switch action {
            case .approve: card.status = .approved
            case .reject: card.status = .rejected
            case .revise:
                card.status = .revised
                card.revisionNote = note
            case .acknowledge: card.status = .acknowledged
            case .delegate: card.status = .delegated
            case .priority: break
            }
            let trimmed = note?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            if !trimmed.isEmpty {
                card.context = [card.context, trimmed].filter { !$0.isEmpty }.joined(separator: "\n")
            }
        }

        userCards[index] = card
        cardsByUser[actorUserID] = userCards
        onCardsUpdated?()
        return card
    }

    /// The relay syncs GitHub only for callers whose session carries a token.
    /// iOS holds the user's OAuth token itself, so it files the issue here and
    /// publishes the link as an update to the decision the relay already made.
    private func syncGitHubIfNeeded(
        _ card: DecisionCard,
        githubService: GitHubService
    ) async throws -> DecisionCard {
        let wantsIssue = card.status == .approved || card.status == .delegated
        guard githubService.isConnected, wantsIssue || card.githubIssueNumber != nil else {
            return card
        }

        var synced = card
        let issue = try await githubService.syncDecision(card)
        synced.githubIssueNumber = issue.number
        synced.githubIssueURL = issue.url
        synced.githubRepository = githubService.linkedRepository

        upsert(synced)
        await webSocketService?.publishUpdated(synced)
        return synced
    }

    private func findCard(_ cardID: String, for userID: String) -> DecisionCard? {
        cardsByUser[userID]?.first { $0.id == cardID }
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
        try await decide(cardID: cardID, action: .acknowledge, actorUserID: actorUserID)
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
        case .presence, .error, .channelSnapshot, .channelCreated, .channelMessage, .orgUpdated:
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
