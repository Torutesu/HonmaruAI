import Foundation

enum RealtimeEvent: Codable {
    case snapshot(cardsByUser: [String: [DecisionCard]])
    case cardCreated(card: DecisionCard)
    case cardUpdated(card: DecisionCard)
    case cardDeleted(cardID: String, recipientUserID: String)
    case presence(userId: String, status: String)
    case error(message: String)

    private enum CodingKeys: String, CodingKey {
        case type, payload
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let type = try container.decode(String.self, forKey: .type)
        switch type {
        case "snapshot":
            let payload = try container.decode(SnapshotPayload.self, forKey: .payload)
            self = .snapshot(cardsByUser: payload.cardsByUser)
        case "card_created":
            let payload = try container.decode(CardPayload.self, forKey: .payload)
            self = .cardCreated(card: payload.card)
        case "card_updated":
            let payload = try container.decode(CardPayload.self, forKey: .payload)
            self = .cardUpdated(card: payload.card)
        case "card_deleted":
            let payload = try container.decode(DeletePayload.self, forKey: .payload)
            self = .cardDeleted(cardID: payload.cardID, recipientUserID: payload.recipientUserID)
        case "presence":
            let payload = try container.decode(PresencePayload.self, forKey: .payload)
            self = .presence(userId: payload.userId, status: payload.status)
        case "error":
            let payload = try container.decode(ErrorPayload.self, forKey: .payload)
            self = .error(message: payload.message)
        default:
            // New relay event types are not evidence that a user's mutation
            // failed. The receive path ignores undecodable legacy events.
            throw DecodingError.dataCorruptedError(forKey: .type, in: container,
                                                   debugDescription: "Unknown event: \(type)")
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .snapshot(let cardsByUser):
            try container.encode("snapshot", forKey: .type)
            try container.encode(SnapshotPayload(cardsByUser: cardsByUser), forKey: .payload)
        case .cardCreated(let card):
            try container.encode("card_created", forKey: .type)
            try container.encode(CardPayload(card: card), forKey: .payload)
        case .cardUpdated(let card):
            try container.encode("card_updated", forKey: .type)
            try container.encode(CardPayload(card: card), forKey: .payload)
        case .cardDeleted(let cardID, let recipientUserID):
            try container.encode("card_deleted", forKey: .type)
            try container.encode(DeletePayload(cardID: cardID, recipientUserID: recipientUserID), forKey: .payload)
        case .presence(let userId, let status):
            try container.encode("presence", forKey: .type)
            try container.encode(PresencePayload(userId: userId, status: status), forKey: .payload)
        case .error(let message):
            try container.encode("error", forKey: .type)
            try container.encode(ErrorPayload(message: message), forKey: .payload)
        }
    }

    private struct SnapshotPayload: Codable {
        let cardsByUser: [String: [DecisionCard]]
    }

    private struct CardPayload: Codable {
        let card: DecisionCard
    }

    private struct DeletePayload: Codable {
        let cardID: String
        let recipientUserID: String

        enum CodingKeys: String, CodingKey {
            case cardID = "cardId"
            case recipientUserID
        }
    }

    private struct PresencePayload: Codable {
        let userId: String
        let status: String
    }

    private struct ErrorPayload: Codable {
        let message: String
    }
}

enum AGUIProtocol {
    static let version = "agui/1"
}

enum OutboundEvent {
    case join(userId: String, orgId: String, sessionToken: String?)
    case cardCreated(DecisionCard)
    case cardUpdated(DecisionCard)
    case cardDeleted(cardID: String, recipientUserID: String)
    case rollback(cardID: String)
    case contextUpdated(text: String)
    case toolResult(card: DecisionCard, decision: Decision, toolCallId: String?)
    /// An envelope replayed from the outbox. It was built by one of the cases
    /// above before it was written to disk, so it is re-sent verbatim rather
    /// than reconstructed — a queue that has to understand its own payloads
    /// breaks the day a case gains a field.
    case raw([String: Any])

    var envelope: [String: Any] {
        switch self {
        case .raw(let object):
            return object
        case .join(let userId, let orgId, let sessionToken):
            // Joining with a protocol marker upgrades the session to the
            // AG-UI dialect; older relays ignore the extra field and keep
            // speaking legacy messages, which we still parse below.
            var payload: [String: Any] = [
                "userId": userId,
                "orgId": orgId,
                "protocol": AGUIProtocol.version,
            ]
            if let sessionToken, !sessionToken.isEmpty { payload["sessionToken"] = sessionToken }
            return ["type": "join", "payload": payload]
        case .cardCreated(let card):
            return ["type": "card_created", "payload": ["card": card.dictionary]]
        case .cardUpdated(let card):
            return ["type": "card_updated", "payload": ["card": card.dictionary]]
        case .cardDeleted(let cardID, let recipientUserID):
            return [
                "type": "card_deleted",
                "payload": ["cardId": cardID, "recipientUserID": recipientUserID]
            ]
        case .rollback(let cardID):
            return ["type": "rollback", "payload": ["cardId": cardID]]
        case .contextUpdated(let text):
            return ["type": "context_updated", "payload": ["context": ["text": text]]]
        case .toolResult(let card, let decision, let toolCallId):
            var content: [String: Any] = [
                "cardId": card.id,
                "action": decision.action,
                "actorUserID": decision.actorUserID,
                "decidedAt": ISO8601DateFormatter().string(from: decision.decidedAt)
            ]
            if let optionId = decision.optionId { content["optionId"] = optionId }
            if let note = decision.note { content["note"] = note }
            if let replyText = decision.replyText { content["replyText"] = replyText }
            // tool_result carries only the decision, not the whole card — the
            // GitHub sync result has to ride along explicitly here or the
            // relay's copy of the card never learns about it.
            if let issueNumber = card.githubIssueNumber { content["githubIssueNumber"] = issueNumber }
            if let issueURL = card.githubIssueURL { content["githubIssueURL"] = issueURL }
            if let repository = card.githubRepository { content["githubRepository"] = repository }

            var payload: [String: Any] = ["content": content]
            if let toolCallId { payload["toolCallId"] = toolCallId }
            return ["type": "tool_result", "payload": payload]
        }
    }
}

/// What the socket is actually doing, as opposed to what a green dot implies.
///
/// `refused` is its own state and not a flavour of `offline`: the relay closes
/// with 1008 when a session cannot join an organization, and retrying that
/// forever would be a battery drain that never succeeds.
enum ConnectionState: Equatable {
    case offline
    case connecting
    case connected
    case refused(String)
}

@MainActor
final class WebSocketService: ObservableObject {
    @Published private(set) var state: ConnectionState = .offline
    @Published private(set) var onlineUserIDs: Set<String> = []
    @Published private(set) var deliveryError: String?

    var isConnected: Bool { state == .connected }

    var onEvent: ((RealtimeEvent) -> Void)?

    private var task: URLSessionWebSocketTask?
    private var receiveLoopTask: Task<Void, Never>?
    private var reconnectTask: Task<Void, Never>?
    private var joinTimeoutTask: Task<Void, Never>?
    private var intentionalDisconnect = false
    private var reconnectAttempt = 0
    private var lastURLString: String?
    private var lastUserID: String?
    private var lastOrgID = "core-team"
    private var lastSessionToken: String?
    private var lastRefusal: String?
    private var connectionGeneration = UUID()
    private let session = URLSession(configuration: .default)
    // Lazy so its main-actor initializer runs on first use rather than in a
    // stored-property default.
    private var outbox: Outbox?
    private var outboxFilename: String?

    /// cardID → recipientUserID, maintained from snapshots and upserts so
    /// AG-UI remove patches (which carry only the card id) can be routed.
    private var cardOwners: [String: String] = [:]
    private lazy var aguiAssembler = AGUIEventAssembler(decoder: decoder)
    private let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        return encoder
    }()

    private let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let value = try container.decode(String.self)
            let formatters = [ISO8601DateFormatter.fractional, ISO8601DateFormatter.standard]
            for formatter in formatters {
                if let date = formatter.date(from: value) {
                    return date
                }
            }
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "Invalid date: \(value)")
        }
        return decoder
    }()

    func connect(urlString: String, userId: String, orgId: String = "core-team", sessionToken: String? = nil) async throws {
        lastURLString = urlString
        lastUserID = userId
        lastOrgID = orgId
        lastSessionToken = sessionToken

        // Tear the previous socket down as intentional so its receive loop does
        // not schedule a reconnect for a connection we are replacing — and then
        // clear the flag, because this connection very much does want to come
        // back. Setting it before the teardown, which is what used to happen,
        // left it true forever and killed auto-reconnect after the first call.
        disconnect(intentional: true)
        let generation = connectionGeneration
        let filename = Outbox.filename(relayURL: urlString, userID: userId, orgID: orgId)
        if filename != outboxFilename {
            outbox = Outbox(filename: filename)
            outboxFilename = filename
            deliveryError = nil
        }
        cardOwners = [:]
        aguiAssembler = AGUIEventAssembler(decoder: decoder)
        intentionalDisconnect = false
        state = .connecting

        guard let url = URL(string: urlString) else {
            state = .offline
            throw URLError(.badURL)
        }

        var request = URLRequest(url: url)
        request.timeoutInterval = 10

        let task = session.webSocketTask(with: request)
        self.task = task
        task.resume()

        receiveLoopTask = Task { [weak self] in
            await self?.receiveLoop(task: task, generation: generation)
        }

        do {
            try await send(.join(userId: userId, orgId: orgId, sessionToken: sessionToken))
        } catch {
            guard generation == connectionGeneration else { throw error }
            state = .offline
            scheduleReconnect()
            throw error
        }
        // The relay's first snapshot confirms that membership and the session
        // were accepted. A successful socket write alone does not mean joined.
        guard generation == connectionGeneration, state == .connecting else { return }
        joinTimeoutTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(15))
            guard !Task.isCancelled, let self,
                  self.connectionGeneration == generation,
                  self.state == .connecting else { return }
            self.state = .offline
            self.scheduleReconnect()
        }
    }

    /// Intentional by default, because every caller outside this file means
    /// "stop" — signing out, mainly. A drop we did not ask for never comes
    /// through here; the receive loop notices it and schedules a reconnect.
    func disconnect(intentional: Bool = true) {
        connectionGeneration = UUID()
        intentionalDisconnect = intentional
        reconnectTask?.cancel()
        reconnectTask = nil
        joinTimeoutTask?.cancel()
        joinTimeoutTask = nil
        receiveLoopTask?.cancel()
        receiveLoopTask = nil
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        if intentional {
            state = .offline
            lastRefusal = nil
        }
        onlineUserIDs = []
    }

    func clearPendingEvents() {
        outbox?.clear()
        if let lastURLString, let lastUserID {
            Outbox.clearAll(relayURL: lastURLString, userID: lastUserID)
        }
        outbox = nil
        outboxFilename = nil
        deliveryError = nil
    }

    func clearDeliveryError() { deliveryError = nil }

    /// Join failures explain refusal. Once joined, an error means a mutation
    /// may have been rejected: surface it and fetch authoritative state again
    /// so an optimistic local card does not continue to look delivered.
    func reportRelayError(_ message: String, wasJoined: Bool) {
        let boundedMessage = String(message.prefix(500))
        if wasJoined {
            deliveryError = boundedMessage
            scheduleReconnect(immediately: true)
        } else {
            lastRefusal = boundedMessage
        }
    }

    /// Reconnect if we are meant to be connected and are not. Called when the
    /// app returns to the foreground and when the network comes back — a socket
    /// dropped while backgrounded produces no receive-loop error to react to, so
    /// waiting for one means never noticing.
    func reconnectIfNeeded() {
        // A refusal is the relay saying this session may never join this org.
        // Retrying it is a battery drain with a known answer.
        if case .refused = state { return }
        // Foregrounding and network recovery can leave a half-open socket
        // looking connected. Rejoining refreshes its state and the feed; a join
        // already in progress has its own timeout and should finish normally.
        guard state != .connecting, lastURLString != nil, !intentionalDisconnect else { return }
        reconnectAttempt = 0
        scheduleReconnect(immediately: true)
    }

    func publishCreated(_ card: DecisionCard) async {
        await publish(.cardCreated(card))
    }

    func publishUpdated(_ card: DecisionCard) async {
        await publish(.cardUpdated(card))
    }

    func publishRollback(cardID: String) async {
        await publish(.rollback(cardID: cardID))
    }

    func publishContext(_ text: String) async {
        await publish(.contextUpdated(text: text))
    }

    func publishDeleted(cardID: String, recipientUserID: String) async {
        await publish(.cardDeleted(cardID: cardID, recipientUserID: recipientUserID))
    }

    /// Send it, or keep it until we can.
    ///
    /// These used to be `try?`: with no socket the send threw, the error was
    /// discarded, and the decision existed only on that device. The person who
    /// made it saw success. The teammate waiting on it never heard. Anything
    /// that fails now waits in the outbox and goes out in order on reconnect —
    /// transport completion still does not prove persistence on the relay.
    private func publish(_ event: OutboundEvent) async {
        guard !intentionalDisconnect, let outbox else { return }
        // Always queue first, including online sends, so a newer action cannot
        // overtake an earlier one during a reconnect or a suspended write.
        outbox.append(event)
        await flushOutbox()
    }

    private func flushOutbox() async {
        guard state == .connected, let outbox else { return }
        let generation = connectionGeneration
        do {
            try await outbox.flush { [weak self] event in
                guard let self, self.connectionGeneration == generation,
                      self.state == .connected else {
                    throw URLError(.notConnectedToInternet)
                }
                try await self.send(event)
                guard self.connectionGeneration == generation,
                      self.state == .connected else { throw CancellationError() }
            }
        } catch {
            guard generation == connectionGeneration else {
                // A replacement connection may have tried to flush while the
                // old transport still held this queue. Its completion releases
                // the lock, so let the current connection pick the queue up.
                await flushOutbox()
                return
            }
            if case .refused = state { return }
            state = .offline
            scheduleReconnect()
        }
    }

    /// Goes through `publish`, not `send`, for the same reason every other
    /// mutation does: a decision made with no socket has to wait in the outbox
    /// rather than disappear. This is the one message where losing it is worst
    /// — the person saw their approval land and the teammate waiting on it
    /// never hears.
    func publishToolResult(_ card: DecisionCard, decision: Decision, toolCallId: String?) async {
        await publish(.toolResult(card: card, decision: decision, toolCallId: toolCallId))
    }

    func toolCallID(for cardID: String) -> String? {
        aguiAssembler.toolCallIDsByCard[cardID]
    }

    private func send(_ event: OutboundEvent) async throws {
        guard let task, state != .offline else { throw URLError(.notConnectedToInternet) }
        let data = try JSONSerialization.data(withJSONObject: event.envelope)
        guard let text = String(data: data, encoding: .utf8) else { return }
        try await task.send(.string(text))
    }

    private func receiveLoop(task: URLSessionWebSocketTask, generation: UUID) async {
        while !Task.isCancelled, generation == connectionGeneration {
            do {
                let message = try await task.receive()
                guard !Task.isCancelled, generation == connectionGeneration else { return }
                switch message {
                case .string(let text):
                    handle(text: text)
                case .data(let data):
                    if let text = String(data: data, encoding: .utf8) {
                        handle(text: text)
                    }
                @unknown default:
                    break
                }
            } catch {
                guard !Task.isCancelled, generation == connectionGeneration else { return }
                // 1008 is the relay refusing this session for this organization
                // — a permanent answer, not a dropped connection. Telling them
                // apart is the difference between showing "reconnecting…" once
                // and showing it forever.
                if task.closeCode == .policyViolation {
                    state = .refused(lastRefusal ?? String(localized: "You are not a member of this organization."))
                } else if state == .connected || state == .connecting {
                    state = .offline
                }
                scheduleReconnect()
                break
            }
        }
    }

    /// Exponential backoff with full jitter, capped at 30s.
    ///
    /// The flat two seconds this replaces meant every device in an org retried
    /// in lockstep after an outage, which is how a relay that just came back
    /// goes down again. Jitter spreads them.
    private func backoffSeconds() -> Double {
        let ceiling = min(30.0, pow(2.0, Double(min(reconnectAttempt, 5))))
        return Double.random(in: 0.5...max(0.5, ceiling))
    }

    private func scheduleReconnect(immediately: Bool = false) {
        guard !intentionalDisconnect,
              let lastURLString,
              let lastUserID else { return }
        if case .refused = state { return }

        let delay = immediately ? 0 : backoffSeconds()
        reconnectAttempt += 1

        reconnectTask?.cancel()
        reconnectTask = Task { [weak self] in
            if delay > 0 { try? await Task.sleep(for: .seconds(delay)) }
            guard let self, !Task.isCancelled, !self.intentionalDisconnect else { return }
            try? await self.connect(
                urlString: lastURLString,
                userId: lastUserID,
                orgId: self.lastOrgID,
                sessionToken: self.lastSessionToken
            )
        }
    }

    private func handle(text: String) {
        guard let data = text.data(using: .utf8) else { return }

        // AG-UI dialect first; anything else falls through to the legacy
        // {type, payload} messages so older relays keep working.
        if let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
           AGUIEventAssembler.isAGUIEvent(json) {
            for event in aguiAssembler.handle(json) {
                dispatch(resolveRecipient(for: event))
            }
            return
        }

        guard let event = try? decoder.decode(RealtimeEvent.self, from: data) else {
            return
        }
        dispatch(event)
    }

    private func dispatch(_ event: RealtimeEvent) {
        trackOwnership(of: event)

        // The relay explains a refusal before it closes, so hold the last
        // explanation to show instead of a generic one when the close lands.
        if case .error(let message) = event {
            reportRelayError(message, wasJoined: state == .connected)
        }

        if case .presence(let userId, let status) = event {
            if status == "online" {
                onlineUserIDs.insert(userId)
            } else {
                onlineUserIDs.remove(userId)
            }
        }

        onEvent?(event)

        if case .snapshot = event, state == .connecting {
            joinTimeoutTask?.cancel()
            joinTimeoutTask = nil
            reconnectAttempt = 0
            state = .connected
            Task { await flushOutbox() }
        }
    }

    private func trackOwnership(of event: RealtimeEvent) {
        switch event {
        case .snapshot(let cardsByUser):
            cardOwners = [:]
            for (userID, cards) in cardsByUser {
                for card in cards {
                    cardOwners[card.id] = userID
                }
            }
        case .cardCreated(let card), .cardUpdated(let card):
            cardOwners[card.id] = card.recipientUserID
        case .cardDeleted(let cardID, _):
            cardOwners.removeValue(forKey: cardID)
        case .presence, .error:
            break
        }
    }

    private func resolveRecipient(for event: RealtimeEvent) -> RealtimeEvent {
        guard case .cardDeleted(let cardID, let recipient) = event,
              recipient.isEmpty else {
            return event
        }
        return .cardDeleted(cardID: cardID, recipientUserID: cardOwners[cardID] ?? "")
    }
}

private extension DecisionCard {
    var dictionary: [String: Any] {
        guard let data = try? JSONEncoder.iso8601.encode(self),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return [:]
        }
        return object
    }
}

private extension JSONEncoder {
    static let iso8601: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        return encoder
    }()
}

private extension ISO8601DateFormatter {
    static let standard: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()

    static let fractional: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
}
