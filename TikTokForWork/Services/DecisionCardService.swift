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
    private var activeUserID: String?
    private var isSeeding = false

    var onCardsUpdated: (() -> Void)?
    var onSeedArrival: ((Int) -> Void)?

    var isSeedingActive: Bool { isSeeding }

    func attach(webSocketService: WebSocketService) {
        self.webSocketService = webSocketService
        webSocketService.onEvent = { [weak self] event in
            self?.handle(event)
        }
    }

    func setActiveUser(_ userID: String) {
        activeUserID = userID
    }

    func applySnapshot(_ incoming: [String: [DecisionCard]]) {
        let incomingIsEmpty = incoming.values.allSatisfy(\.isEmpty)
        let localCards = cardsByUser.values.flatMap { $0 }

        if incomingIsEmpty, !localCards.isEmpty {
            // Relay store is empty but we already hold cards (e.g. a seeded first-run
            // feed before the socket came up): push ours up instead of wiping the feed.
            Task { [weak self] in
                for card in localCards {
                    await self?.webSocketService?.publishCreated(card)
                }
            }
            onCardsUpdated?()
            return
        }

        cardsByUser = incoming
        onCardsUpdated?()

        if incomingIsEmpty {
            seedDemoFeedIfNeeded()
        }
    }

    func bootstrap(for user: User) {
        activeUserID = user.id
        if cardsByUser.isEmpty {
            seedDemoFeedIfNeeded()
        }
        onCardsUpdated?()
    }

    /// Seeds the first-session feed once per install. The current user's cards
    /// stream in with a short stagger so the feed visibly "arrives" instead of
    /// popping in fully formed.
    func seedDemoFeedIfNeeded() {
        guard !UserDefaults.standard.bool(forKey: FirstRunFlags.seededFeed), !isSeeding else { return }
        isSeeding = true
        UserDefaults.standard.set(true, forKey: FirstRunFlags.seededFeed)

        let seeds = DemoData.seedCards()
        let visibleUserID = activeUserID
        let backgroundSeeds = seeds.filter { $0.recipientUserID != visibleUserID }
        let visibleSeeds = seeds
            .filter { $0.recipientUserID == visibleUserID }
            .sorted { $0.createdAt < $1.createdAt }

        for card in backgroundSeeds {
            append(card, for: card.recipientUserID)
        }
        onCardsUpdated?()

        Task { [weak self] in
            guard let self else { return }
            for card in backgroundSeeds {
                await self.webSocketService?.publishCreated(card)
            }
            try? await Task.sleep(for: .milliseconds(350))
            for (index, card) in visibleSeeds.enumerated() {
                self.append(card, for: card.recipientUserID)
                self.onCardsUpdated?()
                await self.webSocketService?.publishCreated(card)
                if index < visibleSeeds.count - 1 {
                    try? await Task.sleep(for: .milliseconds(450))
                }
            }
            self.isSeeding = false
            if !visibleSeeds.isEmpty {
                self.onSeedArrival?(visibleSeeds.count)
            }
        }
    }

    static func resetSeedMarker() {
        UserDefaults.standard.removeObject(forKey: FirstRunFlags.seededFeed)
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
        case .delete:
            return card
        case .viewDetails:
            return card
        }

        if let revisionNote, !revisionNote.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            card.revisionNote = revisionNote.trimmingCharacters(in: .whitespacesAndNewlines)
            card.context = [card.context, "Revision: \(card.revisionNote!)"].filter { !$0.isEmpty }.joined(separator: "\n")
        }

        // GitHub is optional: without a connection the decision is still
        // recorded locally and can sync later once a repository is linked.
        if githubService.isConnected, action == .createIssue || card.githubIssueNumber != nil {
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
            case .approved: card.githubIssueNumber != nil ? "created GitHub issue" : "approved"
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
            githubIssueNumber: card.githubIssueNumber,
            githubIssueURL: card.githubIssueURL,
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
        if githubService.isConnected {
            let synced = try await githubService.syncDecision(card)
            card.githubIssueNumber = synced.number
            card.githubIssueURL = synced.url
            card.githubRepository = githubService.linkedRepository
        }

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
            githubIssueNumber: card.githubIssueNumber,
            githubIssueURL: card.githubIssueURL,
            githubRepository: card.githubRepository,
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
            githubIssueNumber: card.githubIssueNumber,
            githubIssueURL: card.githubIssueURL,
            githubRepository: card.githubRepository,
            agentRoute: delegatedCard.agentRoute,
            routingReason: "Delegation update"
        )

        append(responseCard, for: card.senderUserID)
        await webSocketService?.publishCreated(responseCard)
        onCardsUpdated?()
        return card
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
        from sender: User,
        videoURL: String? = nil
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
            videoURL: videoURL
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

    private func remove(cardID: String, for userID: String) {
        var cards = cardsByUser[userID, default: []]
        cards.removeAll { $0.id == cardID }
        cardsByUser[userID] = cards
        onCardsUpdated?()
    }
}
