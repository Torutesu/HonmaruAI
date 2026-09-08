import Foundation

@MainActor
protocol DecisionGitHubSyncing {
    var isConnected: Bool { get }
    var linkedRepository: String { get }
    func syncDecision(_ card: DecisionCard) async throws -> (number: Int, url: String)
    func issueState(number: Int) async throws -> String
}

extension GitHubService: DecisionGitHubSyncing {}

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
    private var scopeGeneration = UUID()

    /// How many decisions are waiting on the person using this device.
    ///
    /// Counted here rather than in the feed view model because two places need
    /// it — the tab bar and the app icon — and a count computed twice is a count
    /// that eventually disagrees with itself.
    @Published private(set) var pendingCount = 0

    var onCardsUpdated: (() -> Void)?

    func attach(webSocketService: WebSocketService) {
        self.webSocketService = webSocketService
        webSocketService.onEvent = { [weak self] event in
            self?.handle(event)
        }
    }

    func setActiveUser(_ userID: String) {
        if activeUserID != userID { scopeGeneration = UUID() }
        activeUserID = userID
    }

    /// Adopt an organization and show whatever we last knew of it, before the
    /// socket has said anything. This is the difference between launching into
    /// your feed and launching into a blank screen.
    func adoptOrganization(_ orgID: String) {
        scopeGeneration = UUID()
        self.orgID = orgID
        cardsByUser = CardCache.load(orgID: orgID)
        changed()
    }

    func applySnapshot(_ incoming: [String: [DecisionCard]]) {
        // A joined relay is authoritative even when its last card was deleted
        // on another device. Ignoring an empty snapshot resurrected that card
        // from the cache on every launch.
        cardsByUser = incoming
        changed()
    }

    func bootstrap(for user: User) {
        setActiveUser(user.id)
        changed()
    }

    /// No-op: demo seeding is disabled. The feed starts empty and fills only
    /// from real relay events. Method retained so call sites that have not yet
    /// been removed still compile.
    func seedDemoFeedIfNeeded() {}

    func reset() {
        scopeGeneration = UUID()
        activeUserID = nil
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
        let pending = activeUserID.map { cardsByUser[$0, default: []].filter(\.isPending).count } ?? 0
        if pending != pendingCount {
            pendingCount = pending
            PushService.shared.setBadge(pending)
        }
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

    func syncGitHubStatus(githubService: any DecisionGitHubSyncing) async {
        let generation = scopeGeneration
        guard githubService.isConnected else { return }
        // Only our own cards. The store holds the whole org so a second device
        // can stay in sync passively, but a card belongs to the person who has
        // to decide it — republishing someone else's is a write the relay is
        // right to refuse, and reconciling their issue was never our job.
        guard let userID = activeUserID, var userCards = cardsByUser[userID] else { return }

        var didChange = false
        for index in userCards.indices {
            guard generation == scopeGeneration else { return }
            guard let issueNumber = userCards[index].githubIssueNumber else { continue }
            guard userCards[index].githubRepository == githubService.linkedRepository else { continue }

            let status = userCards[index].status
            guard status == .approved || status == .completed || status == .delegated else {
                continue
            }

            do {
                let issueState = try await githubService.issueState(number: issueNumber)
                guard generation == scopeGeneration else { return }
                if issueState == "closed", status != .completed {
                    userCards[index].status = .completed
                    didChange = true
                    await webSocketService?.publishUpdated(userCards[index])
                    guard generation == scopeGeneration else { return }
                } else if issueState == "open", status == .completed {
                    userCards[index].status = .approved
                    didChange = true
                    await webSocketService?.publishUpdated(userCards[index])
                    guard generation == scopeGeneration else { return }
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
        githubService: any DecisionGitHubSyncing
    ) async throws -> DecisionCard {
        let generation = scopeGeneration
        guard activeUserID == actorUserID else { throw CancellationError() }
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
            try ensureCurrentScope(generation)
            card.githubIssueNumber = synced.number
            card.githubIssueURL = synced.url
            card.githubRepository = githubService.linkedRepository
        }

        let decision = Decision(
            action: actionToString(action),
            optionId: nil,
            note: revisionNote,
            replyText: nil,
            actorUserID: actorUserID,
            decidedAt: .now
        )

        card.decision = decision
        userCards[index] = card
        cardsByUser[actorUserID] = userCards

        let toolCallId = webSocketService?.toolCallID(for: cardID)
        await webSocketService?.publishToolResult(card, decision: decision, toolCallId: toolCallId)
        try ensureCurrentScope(generation)

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
        try ensureCurrentScope(generation)
        changed()
        return card
    }

    @discardableResult
    func delegate(
        cardID: String,
        to recipientUserID: String,
        actorUserID: String,
        organization: OrganizationGraph,
        githubService: any DecisionGitHubSyncing
    ) async throws -> DecisionCard {
        let generation = scopeGeneration
        guard activeUserID == actorUserID else { throw CancellationError() }
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
            try ensureCurrentScope(generation)
            card.githubIssueNumber = synced.number
            card.githubIssueURL = synced.url
            card.githubRepository = githubService.linkedRepository
        }

        let decision = Decision(
            action: "delegate",
            optionId: nil,
            note: nil,
            replyText: nil,
            actorUserID: actorUserID,
            decidedAt: .now
        )

        card.decision = decision
        userCards[index] = card
        cardsByUser[actorUserID] = userCards

        let toolCallId = webSocketService?.toolCallID(for: cardID)
        await webSocketService?.publishToolResult(card, decision: decision, toolCallId: toolCallId)
        try ensureCurrentScope(generation)

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
        try ensureCurrentScope(generation)

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
        try ensureCurrentScope(generation)
        changed()
        return card
    }

    func delete(cardID: String, actorUserID: String) async throws {
        let generation = scopeGeneration
        guard activeUserID == actorUserID else { throw CancellationError() }
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
        try ensureCurrentScope(generation)
        changed()
    }

    @discardableResult
    func processRouting(
        _ routing: InstructionRouting,
        sourceText: String,
        from sender: User,
        videoURL: String? = nil
    ) async throws -> DecisionCard {
        let generation = scopeGeneration
        guard activeUserID == sender.id else { throw CancellationError() }
        if let orgID, sender.teamID != orgID { throw CancellationError() }
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
            business: routing.business,
            videoURL: videoURL
        )

        append(card, for: routing.recipientID)
        await webSocketService?.publishCreated(card)
        try ensureCurrentScope(generation)
        changed()
        return card
    }

    private func ensureCurrentScope(_ generation: UUID) throws {
        guard scopeGeneration == generation else { throw CancellationError() }
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

    private func actionToString(_ action: CardActionKind) -> String {
        switch action {
        case .createIssue: "approve"
        case .reject: "decline"
        case .requestRevision: "revised"
        case .delegate: "delegate"
        case .delete: "delete"
        case .viewDetails: "acknowledge"
        }
    }
}
