import Foundation

enum CardServiceError: LocalizedError {
    case githubSyncFailed(String)
    case cardNotFound

    var errorDescription: String? {
        switch self {
        case .githubSyncFailed(let message): message
        case .cardNotFound: String(localized: "Card not found.")
        }
    }
}

@MainActor
final class DecisionCardService: ObservableObject {
    private var cardsByUser: [String: [DecisionCard]] = [:]
    private weak var webSocketService: WebSocketService?
    private var activeUserID: String?
    private var orgID: String?
    private var persistTask: Task<Void, Never>?

    var onCardsUpdated: (() -> Void)?

    func attach(webSocketService: WebSocketService) {
        self.webSocketService = webSocketService
        webSocketService.onEvent = { [weak self] event in
            self?.handle(event)
        }
    }

    func setActiveUser(_ userID: String) {
        activeUserID = userID
    }

    /// Adopt an organization and show whatever we last knew of it, before the
    /// socket has said anything. This is the difference between launching into
    /// your feed and launching into a blank screen.
    func adoptOrganization(_ orgID: String) {
        self.orgID = orgID
        cardsByUser = CardCache.load(orgID: orgID)
        changed()
    }

    func applySnapshot(_ incoming: [String: [DecisionCard]]) {
        // An empty snapshot is not the same as "there is nothing". It is what a
        // relay sends before anything has been published, and adopting it would
        // wipe a cache that is currently the only copy of the user's feed.
        if incoming.isEmpty, !cardsByUser.isEmpty { return }
        cardsByUser = incoming
        changed()
    }

    func bootstrap(for user: User) {
        activeUserID = user.id
        changed()
    }

    /// No-op: demo seeding is disabled. The feed starts empty and fills only
    /// from real relay events. Method retained so call sites that have not yet
    /// been removed still compile.
    func seedDemoFeedIfNeeded() {}

    func reset() {
        cardsByUser = [:]
        orgID = nil
        persistTask?.cancel()
        CardCache.clear()
        changed()
    }

    /// Every mutation goes through here, so caching is not something a new
    /// code path has to remember to do.
    private func changed() {
        persist()
        onCardsUpdated?()
    }

    /// Debounced: a snapshot arriving as a burst of upserts would otherwise
    /// rewrite the whole file once per card.
    private func persist() {
        guard let orgID else { return }
        persistTask?.cancel()
        let snapshot = cardsByUser
        persistTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(300))
            guard !Task.isCancelled, self != nil else { return }
            CardCache.save(orgID: orgID, cardsByUser: snapshot)
        }
    }

    func syncGitHubStatus(githubService: GitHubService) async {
        guard githubService.isConnected else { return }
        // Only our own cards. The store holds the whole org so a second device
        // can stay in sync passively, but a card belongs to the person who has
        // to decide it — republishing someone else's is a write the relay is
        // right to refuse, and reconciling their issue was never our job.
        guard let userID = activeUserID, var userCards = cardsByUser[userID] else { return }

        var didChange = false
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
                    didChange = true
                    await webSocketService?.publishUpdated(userCards[index])
                } else if issueState == "open", status == .completed {
                    userCards[index].status = .approved
                    didChange = true
                    await webSocketService?.publishUpdated(userCards[index])
                }
            } catch {
                continue
            }
        }

        if didChange {
            cardsByUser[userID] = userCards
            changed()
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
            summary: "\(DisplayName.of(actorUserID)) · \(statusLabel)",
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
        changed()
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
            throw CardServiceError.githubSyncFailed(String(localized: "Pick someone else to delegate to."))
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

        let actorName = DisplayName.of(actorUserID, in: organization)
        let recipientName = DisplayName.of(recipientUserID, in: organization)
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
        changed()
        return card
    }

    func delete(cardID: String, actorUserID: String) async throws {
        guard var userCards = cardsByUser[actorUserID],
              let index = userCards.firstIndex(where: { $0.id == cardID }) else {
            throw CardServiceError.cardNotFound
        }

        let card = userCards[index]
        guard card.canDelete else {
            throw CardServiceError.githubSyncFailed(String(localized: "Only declined cards can be deleted."))
        }

        userCards.remove(at: index)
        cardsByUser[actorUserID] = userCards
        await webSocketService?.publishDeleted(cardID: cardID, recipientUserID: actorUserID)
        changed()
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
        changed()
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
        changed()
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
        changed()
    }
}
