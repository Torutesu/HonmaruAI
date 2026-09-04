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

    /// How many decisions are waiting on the person using this device.
    ///
    /// Counted here rather than in the feed view model because two places need
    /// it — the tab bar and the app icon — and a count computed twice is a count
    /// that eventually disagrees with itself.
    @Published private(set) var pendingCount = 0

    /// How many of the decisions you asked for have gone quiet.
    ///
    /// Owned here for the same reason `pendingCount` is: two screens want it,
    /// and a count computed twice is a count that eventually disagrees with
    /// itself.
    @Published private(set) var stuckSentCount = 0

    /// Bumped on every change to the store.
    ///
    /// A view that shows a *derived* list — the sent list is computed, not
    /// stored — has nothing else to watch: the published counts only move when
    /// their own number changes, and someone else approving your request moves
    /// neither. `onCardsUpdated` is a single closure and already has an owner.
    @Published private(set) var changeCount = 0

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
        // Decisions only. An update someone sent you to read is not a thing
        // anyone is waiting on, and counting it made the badge mean "unread".
        let pending = activeUserID.map { cardsByUser[$0, default: []].filter(\.needsDecision).count } ?? 0
        if pending != pendingCount {
            pendingCount = pending
            PushService.shared.setBadge(pending)
        }
        let stuck = activeUserID.map { sentCards(by: $0).filter(\.isStale).count } ?? 0
        if stuck != stuckSentCount { stuckSentCount = stuck }
        changeCount &+= 1
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
        guard let userID = activeUserID else { return }

        // Decisions that were made while GitHub was out of reach. The decision
        // itself was recorded and delivered at the time; this is the issue
        // catching up with it.
        for card in cardsByUser[userID, default: []] where card.githubSyncPending == true {
            await syncDecisionToGitHub(cardID: card.id, ownerUserID: userID, githubService: githubService)
        }

        // Only our own cards. The store holds the whole org so a second device
        // can stay in sync passively, but a card belongs to the person who has
        // to decide it — republishing someone else's is a write the relay is
        // right to refuse, and reconciling their issue was never our job.
        guard var userCards = cardsByUser[userID] else { return }

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
                // Reported as bookkeeping, not as a decision. Sent as a whole
                // card it carried the decision with it, so the relay treated
                // every one of these as someone deciding all over again.
                if issueState == "closed", status != .completed {
                    userCards[index].status = .completed
                    didChange = true
                    await webSocketService?.publishSynced(cardID: userCards[index].id, status: .completed)
                } else if issueState == "open", status == .completed {
                    userCards[index].status = .approved
                    didChange = true
                    await webSocketService?.publishSynced(cardID: userCards[index].id, status: .approved)
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

    /// What you have asked other people for, newest first.
    ///
    /// Half the product was missing without this. You could send a decision and
    /// then never see it again: the answer came back as a one-line update in
    /// your feed, which scrolls, and there was nowhere to look up whether the
    /// thing you asked for last Tuesday ever happened — or to do anything about
    /// it if it had not.
    ///
    /// The store is keyed by recipient, so this reads across it. The relay now
    /// gives each device the cards it is party to, which is exactly these plus
    /// your own feed.
    func sentCards(by userID: String) -> [DecisionCard] {
        cardsByUser.values
            .flatMap { $0 }
            .filter { $0.senderUserID == userID && $0.recipientUserID != userID }
            // A reminder is a copy of a question already on this list.
            .filter { $0.isDecision }
            .sorted { $0.createdAt > $1.createdAt }
    }

    /// Ask again, without asking twice.
    ///
    /// The SLA chip has said "Waiting 5d" since it was built and there was
    /// nothing to do about it — you only see cards routed *to* you, so there was
    /// no screen on which to nudge anyone. It lands as an update rather than a
    /// second decision: the original card is still the one to answer, and two
    /// cards asking the same question is how a feed stops being a list of what
    /// is left.
    @discardableResult
    func nudge(cardID: String, from actorUserID: String, organization: OrganizationGraph) async throws -> DecisionCard {
        guard let original = cardsByUser.values.flatMap({ $0 })
            .first(where: { $0.id == cardID && $0.senderUserID == actorUserID }) else {
            throw CardServiceError.cardNotFound
        }
        guard original.isPending else { return original }

        let senderName = DisplayName.of(actorUserID, in: organization)
        let days = original.waitingDays
        let reminder = DecisionCard(
            id: UUID().uuidString,
            recipientUserID: original.recipientUserID,
            senderUserID: actorUserID,
            type: .notification,
            title: original.title,
            summary: days.map { String(localized: "\(senderName) is still waiting, \($0) days on") }
                ?? String(localized: "\(senderName) is still waiting"),
            context: original.summary,
            status: .pending,
            priority: original.priority,
            createdAt: .now,
            agentRoute: original.agentRoute,
            routingReason: String(localized: "A reminder about a decision you have open")
        )

        append(reminder, for: reminder.recipientUserID)
        await webSocketService?.publishCreated(reminder)
        changed()
        return reminder
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
        case .acknowledge: card.status = .completed
        case .delegate, .delete, .viewDetails:
            return card
        }

        if let revisionNote, !revisionNote.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            card.revisionNote = revisionNote.trimmingCharacters(in: .whitespacesAndNewlines)
            card.context = [card.context, "Revision: \(card.revisionNote!)"].filter { !$0.isEmpty }.joined(separator: "\n")
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

        // The decision is recorded and delivered before GitHub hears about it.
        // It used to be the other way round: `syncDecision` was awaited first,
        // and it throws, so approving with no network threw *before* the
        // decision existed — the person saw an error, the teammate waiting on
        // it heard nothing, and the outbox built for exactly this moment was
        // never reached. Deciding is the product; the issue is bookkeeping.
        // Approving opens an issue. Declining and asking for a change only
        // reach GitHub when there is already an issue to answer: a request
        // that was turned down produced no work, and opening an issue to say
        // so would fill the tracker with things nobody has to do.
        let wantsGitHub = githubService.isConnected
            && card.isDecision
            && (action == .createIssue || card.githubIssueNumber != nil)
        card.githubSyncPending = wantsGitHub ? true : nil
        userCards[index] = card
        cardsByUser[actorUserID] = userCards

        let toolCallId = webSocketService?.toolCallID(for: cardID)
        await webSocketService?.publishToolResult(card, decision: decision, toolCallId: toolCallId)

        // An update is read, not decided, so there is nobody to report it to.
        // Reporting it produced a fresh pending card for the person who had
        // just decided — which they could approve, which reported it back.
        guard card.isDecision else {
            changed()
            return card
        }

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

        // Down a delegation chain the sender is whoever handed the card on, not
        // whoever needed the answer. A → B → C left A watching a card that said
        // "delegated" and never hearing what C decided.
        if let origin = card.originSenderUserID, origin != card.senderUserID, origin != actorUserID {
            let forOrigin = DecisionCard(
                id: UUID().uuidString,
                recipientUserID: origin,
                senderUserID: actorUserID,
                type: .notification,
                title: card.title,
                summary: responseCard.summary,
                context: String(localized: "Passed to \(DisplayName.of(actorUserID)) by \(DisplayName.of(card.senderUserID))"),
                status: .pending,
                priority: .medium,
                createdAt: .now,
                githubIssueNumber: card.githubIssueNumber,
                githubIssueURL: card.githubIssueURL,
                agentRoute: card.agentRoute,
                routingReason: card.routingReason
            )
            append(forOrigin, for: origin)
            await webSocketService?.publishCreated(forOrigin)
        }
        changed()

        if wantsGitHub {
            await syncDecisionToGitHub(
                cardID: cardID,
                ownerUserID: actorUserID,
                githubService: githubService,
                comment: githubComment(for: action, by: actorUserID, note: card.revisionNote)
            )
        }
        return cardsByUser[actorUserID]?.first { $0.id == cardID } ?? card
    }

    /// What to say on the issue, when a decision is worth more than a state
    /// change. An approval is explained by the issue existing; a refusal and a
    /// request for changes are not explained by anything unless someone says so.
    private func githubComment(for action: CardActionKind, by actorUserID: String, note: String?) -> String? {
        let who = DisplayName.of(actorUserID)
        switch action {
        case .reject:
            return note.map { String(localized: "Declined by \(who): \($0)") }
                ?? String(localized: "Declined by \(who).")
        case .requestRevision:
            return note.map { String(localized: "\(who) asked for a change: \($0)") }
                ?? String(localized: "\(who) asked for a change.")
        default:
            return nil
        }
    }

    /// Tell GitHub about a decision that has already been made.
    ///
    /// Never throws. The decision stands whether or not the issue does, and a
    /// card whose sync failed keeps `githubSyncPending` so the next sweep tries
    /// again — which is what makes an approval on a train reach GitHub when the
    /// train comes out of the tunnel.
    private func syncDecisionToGitHub(
        cardID: String,
        ownerUserID: String,
        githubService: GitHubService,
        assignee: String? = nil,
        comment: String? = nil
    ) async {
        guard githubService.isConnected,
              var cards = cardsByUser[ownerUserID],
              let index = cards.firstIndex(where: { $0.id == cardID }) else { return }
        do {
            let synced = try await githubService.syncDecision(
                cards[index], assignee: assignee, comment: comment
            )
            cards[index].githubIssueNumber = synced.number
            cards[index].githubIssueURL = synced.url
            cards[index].githubRepository = githubService.linkedRepository
            cards[index].githubSyncPending = nil
            cardsByUser[ownerUserID] = cards
            await webSocketService?.publishSynced(
                cardID: cardID,
                issueNumber: synced.number,
                issueURL: synced.url,
                repository: githubService.linkedRepository
            )
            changed()
        } catch {
            // Still pending, and still recorded. Nothing here is worth
            // interrupting someone over: they made the decision, and they will
            // not be asked to make it again.
        }
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

        let decision = Decision(
            action: "delegate",
            optionId: nil,
            note: nil,
            replyText: nil,
            actorUserID: actorUserID,
            decidedAt: .now
        )

        card.decision = decision
        // Handing work on is a decision, and it is made here — not once GitHub
        // has agreed. Same rule as `resolve`.
        let wantsGitHub = githubService.isConnected
        card.githubSyncPending = wantsGitHub ? true : nil
        userCards[index] = card
        cardsByUser[actorUserID] = userCards

        let toolCallId = webSocketService?.toolCallID(for: cardID)
        await webSocketService?.publishToolResult(card, decision: decision, toolCallId: toolCallId)

        let actorName = DisplayName.of(actorUserID, in: organization)
        let recipientName = DisplayName.of(recipientUserID, in: organization)
        let delegatedCard = DecisionCard(
            id: UUID().uuidString,
            recipientUserID: recipientUserID,
            senderUserID: actorUserID,
            // Whoever asked first stays named all the way down the chain.
            originSenderUserID: card.originSenderUserID ?? card.senderUserID,
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

        if wantsGitHub {
            await syncDecisionToGitHub(
                cardID: cardID,
                ownerUserID: actorUserID,
                githubService: githubService,
                // Handing work on and not moving the assignee is how a tracker
                // ends up telling you the wrong person is doing something.
                assignee: recipientUserID,
                comment: String(localized: "\(actorName) passed this to \(recipientName).")
            )
        }
        return cardsByUser[actorUserID]?.first { $0.id == cardID } ?? card
    }

    /// Change what the recipient may change about their own card: how urgent it
    /// is, and the words, after asking their AI to rework them.
    ///
    /// The brief lists changing priority and giving your AI further
    /// instructions among the things a person does with a card. Neither
    /// existed: priority could only be set by the sender, at draft time, and
    /// there was no way to ask your own AI anything about a card in front of
    /// you.
    @discardableResult
    func applyEdit(
        cardID: String,
        actorUserID: String,
        title: String? = nil,
        summary: String? = nil,
        context: String? = nil,
        priority: CardPriority? = nil
    ) async throws -> DecisionCard {
        guard var userCards = cardsByUser[actorUserID],
              let index = userCards.firstIndex(where: { $0.id == cardID }) else {
            throw CardServiceError.cardNotFound
        }
        var card = userCards[index]
        // A decided card is a record. Editing one changes the terms of a
        // question that has been answered.
        guard card.isPending else { return card }

        let filled = { (value: String?) -> String? in
            guard let value = value?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else {
                return nil
            }
            return value
        }
        if let title = filled(title) { card.title = title }
        if let summary = filled(summary) { card.summary = summary }
        if let context = filled(context) { card.context = context }
        if let priority { card.priority = priority }

        userCards[index] = card
        cardsByUser[actorUserID] = userCards
        await webSocketService?.publishUpdated(card)
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
            throw CardServiceError.githubSyncFailed(
                String(localized: "A pending decision cannot be deleted. Decline it first.")
            )
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
        case .presence, .error, .context:
            // Presence is the shell's business and context is the app's; the
            // card store has no opinion on either.
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
        case .acknowledge, .viewDetails: "acknowledge"
        }
    }
}
