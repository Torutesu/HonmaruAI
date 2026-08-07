import Foundation

// Client-side view of the protocol v1 WebSocket stream
// (backend/packages/protocol/src/ws.ts).
enum RealtimeEvent {
    case welcome(
        selfMember: ProtocolMember,
        org: ProtocolOrg,
        members: [ProtocolMember],
        teams: [ProtocolTeam],
        edges: [ProtocolEdge],
        channels: [ChatChannel]
    )
    case snapshot(cards: [DecisionCard])
    case cardCreated(card: DecisionCard)
    case cardUpdated(card: DecisionCard, previousRecipientUserID: String?)
    case cardDeleted(cardID: String, recipientUserID: String, senderUserID: String)
    case memberChanged(member: ProtocolMember)
    case messageCreated(message: CardMessage)
    case channelCreated(channel: ChatChannel)
    case chatMessageCreated(message: ChatMessage)
    case notification(NotificationItem)
    case presence(userId: String, status: String)
    case ack(clientRef: String?, card: DecisionCard?)
    case error(code: String, message: String)
    case ignored
}

@MainActor
final class WebSocketService: ObservableObject {
    @Published private(set) var isConnected = false
    @Published private(set) var onlineUserIDs: Set<String> = []

    var onEvent: ((RealtimeEvent) -> Void)?

    private var task: URLSessionWebSocketTask?
    private var receiveLoopTask: Task<Void, Never>?
    private var reconnectTask: Task<Void, Never>?
    private var intentionalDisconnect = false
    private var lastURLString: String?
    private var lastToken: String?
    private var lastOrgID: String?
    // Resume cursor: highest event seq seen; reconnects replay the gap.
    private var lastSeq: Int?
    private let session = URLSession(configuration: .default)

    private let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let value = try container.decode(String.self)
            for formatter in [ISO8601DateFormatter.fractional, ISO8601DateFormatter.standard] {
                if let date = formatter.date(from: value) {
                    return date
                }
            }
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "Invalid date: \(value)")
        }
        return decoder
    }()

    func connect(urlString: String, token: String, orgId: String) async throws {
        intentionalDisconnect = false
        lastURLString = urlString
        lastToken = token
        if lastOrgID != orgId {
            lastSeq = nil
        }
        lastOrgID = orgId
        teardown()

        guard let url = URL(string: urlString) else {
            throw URLError(.badURL)
        }

        var request = URLRequest(url: url)
        request.timeoutInterval = 10

        let task = session.webSocketTask(with: request)
        self.task = task
        task.resume()

        receiveLoopTask = Task { [weak self] in
            await self?.receiveLoop()
        }

        var hello: [String: Any] = ["type": "hello", "token": token, "orgId": orgId]
        if let lastSeq {
            hello["sinceSeq"] = lastSeq
        }
        try await send(hello)
        isConnected = true
    }

    func disconnect(intentional: Bool = true) {
        intentionalDisconnect = intentional
        reconnectTask?.cancel()
        reconnectTask = nil
        teardown()
        lastSeq = nil
        onlineUserIDs = []
    }

    private func teardown() {
        receiveLoopTask?.cancel()
        receiveLoopTask = nil
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        isConnected = false
    }

    // MARK: - Outbound intent (the server owns all state changes)

    func sendInstruction(text: String, priorityOverride: CardPriority? = nil) async {
        var payload: [String: Any] = [
            "type": "instruction",
            "clientRef": UUID().uuidString,
            "text": text,
        ]
        if let priorityOverride {
            payload["priorityOverride"] = priorityOverride.rawValue
        }
        try? await send(payload)
    }

    func sendCardAction(
        cardID: String,
        action: String,
        note: String? = nil,
        delegateToUserID: String? = nil
    ) async {
        var payload: [String: Any] = [
            "type": "card_action",
            "clientRef": UUID().uuidString,
            "cardId": cardID,
            "action": action,
        ]
        if let note, !note.isEmpty {
            payload["note"] = note
        }
        if let delegateToUserID {
            payload["delegateToUserId"] = delegateToUserID
        }
        try? await send(payload)
    }

    func sendCardMessage(cardID: String, text: String) async {
        try? await send([
            "type": "card_message",
            "clientRef": UUID().uuidString,
            "cardId": cardID,
            "text": text,
        ])
    }

    func sendChatMessage(channelID: String, text: String, parentMessageID: String? = nil) async {
        var payload: [String: Any] = [
            "type": "chat_message",
            "clientRef": UUID().uuidString,
            "channelId": channelID,
            "text": text,
        ]
        if let parentMessageID {
            payload["parentMessageId"] = parentMessageID
        }
        try? await send(payload)
    }

    private func send(_ envelope: [String: Any]) async throws {
        guard let task else { throw URLError(.notConnectedToInternet) }
        let data = try JSONSerialization.data(withJSONObject: envelope)
        guard let text = String(data: data, encoding: .utf8) else { return }
        try await task.send(.string(text))
    }

    // MARK: - Inbound

    private func receiveLoop() async {
        while !Task.isCancelled, let task {
            do {
                let message = try await task.receive()
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
                isConnected = false
                scheduleReconnect()
                break
            }
        }
    }

    private func scheduleReconnect() {
        guard !intentionalDisconnect,
              let lastURLString,
              let lastToken,
              let lastOrgID else { return }

        reconnectTask?.cancel()
        reconnectTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(2))
            guard let self, !Task.isCancelled, !self.intentionalDisconnect else { return }
            try? await self.connect(urlString: lastURLString, token: lastToken, orgId: lastOrgID)
        }
    }

    private func handle(text: String) {
        guard let data = text.data(using: .utf8) else { return }
        guard let event = decodeFrame(data) else { return }

        if case .presence(let userId, let status) = event {
            if status == "online" {
                onlineUserIDs.insert(userId)
            } else {
                onlineUserIDs.remove(userId)
            }
        }
        if case .ignored = event { return }
        onEvent?(event)
    }

    private func decodeFrame(_ data: Data) -> RealtimeEvent? {
        struct Head: Decodable { let type: String }
        guard let head = try? decoder.decode(Head.self, from: data) else { return nil }

        switch head.type {
        case "welcome":
            struct Frame: Decodable {
                let selfMember: ProtocolMember
                let org: ProtocolOrg
                let members: [ProtocolMember]
                let teams: [ProtocolTeam]
                let edges: [ProtocolEdge]
                let channels: [ChatChannel]?
                let seq: Int
                enum CodingKeys: String, CodingKey {
                    case selfMember = "self"
                    case org, members, teams, edges, channels, seq
                }
            }
            guard let frame = try? decoder.decode(Frame.self, from: data) else { return nil }
            lastSeq = max(lastSeq ?? 0, frame.seq)
            return .welcome(
                selfMember: frame.selfMember,
                org: frame.org,
                members: frame.members,
                teams: frame.teams,
                edges: frame.edges,
                channels: frame.channels ?? []
            )

        case "snapshot":
            struct Frame: Decodable { let cards: [DecisionCard]; let seq: Int }
            guard let frame = try? decoder.decode(Frame.self, from: data) else { return nil }
            lastSeq = max(lastSeq ?? 0, frame.seq)
            return .snapshot(cards: frame.cards)

        case "event":
            return decodeOrgEvent(data)

        case "ack":
            struct Frame: Decodable { let clientRef: String?; let card: DecisionCard? }
            guard let frame = try? decoder.decode(Frame.self, from: data) else { return nil }
            return .ack(clientRef: frame.clientRef, card: frame.card)

        case "presence":
            struct Frame: Decodable { let userId: String; let status: String }
            guard let frame = try? decoder.decode(Frame.self, from: data) else { return nil }
            return .presence(userId: frame.userId, status: frame.status)

        case "notification":
            struct Frame: Decodable { let notification: NotificationItem }
            guard let frame = try? decoder.decode(Frame.self, from: data) else { return nil }
            return .notification(frame.notification)

        case "error":
            struct Frame: Decodable { let code: String; let message: String }
            guard let frame = try? decoder.decode(Frame.self, from: data) else { return nil }
            return .error(code: frame.code, message: frame.message)

        default:
            // pong / future frames: safe to skip.
            return .ignored
        }
    }

    private func decodeOrgEvent(_ data: Data) -> RealtimeEvent? {
        struct EventHead: Decodable {
            let event: Inner
            struct Inner: Decodable { let type: String; let seq: Int }
        }
        guard let head = try? decoder.decode(EventHead.self, from: data) else { return nil }
        lastSeq = max(lastSeq ?? 0, head.event.seq)

        switch head.event.type {
        case "card_created":
            struct Frame: Decodable {
                let event: Inner
                struct Inner: Decodable { let payload: Payload }
                struct Payload: Decodable { let card: DecisionCard }
            }
            guard let frame = try? decoder.decode(Frame.self, from: data) else { return nil }
            return .cardCreated(card: frame.event.payload.card)

        case "card_updated":
            struct Frame: Decodable {
                let event: Inner
                struct Inner: Decodable { let payload: Payload }
                struct Payload: Decodable {
                    let card: DecisionCard
                    let previousRecipientUserId: String?
                }
            }
            guard let frame = try? decoder.decode(Frame.self, from: data) else { return nil }
            return .cardUpdated(
                card: frame.event.payload.card,
                previousRecipientUserID: frame.event.payload.previousRecipientUserId
            )

        case "card_deleted":
            struct Frame: Decodable {
                let event: Inner
                struct Inner: Decodable { let payload: Payload }
                struct Payload: Decodable {
                    let cardId: String
                    let recipientUserId: String
                    let senderUserId: String
                }
            }
            guard let frame = try? decoder.decode(Frame.self, from: data) else { return nil }
            return .cardDeleted(
                cardID: frame.event.payload.cardId,
                recipientUserID: frame.event.payload.recipientUserId,
                senderUserID: frame.event.payload.senderUserId
            )

        case "channel_created":
            struct Frame: Decodable {
                let event: Inner
                struct Inner: Decodable { let payload: Payload }
                struct Payload: Decodable { let channel: ChatChannel }
            }
            guard let frame = try? decoder.decode(Frame.self, from: data) else { return nil }
            return .channelCreated(channel: frame.event.payload.channel)

        case "chat_message_created":
            struct Frame: Decodable {
                let event: Inner
                struct Inner: Decodable { let payload: Payload }
                struct Payload: Decodable { let message: ChatMessage }
            }
            guard let frame = try? decoder.decode(Frame.self, from: data) else { return nil }
            return .chatMessageCreated(message: frame.event.payload.message)

        case "member_joined", "member_updated":
            struct Frame: Decodable {
                let event: Inner
                struct Inner: Decodable { let payload: Payload }
                struct Payload: Decodable { let member: ProtocolMember }
            }
            guard let frame = try? decoder.decode(Frame.self, from: data) else { return nil }
            return .memberChanged(member: frame.event.payload.member)

        case "message_created":
            struct Frame: Decodable {
                let event: Inner
                struct Inner: Decodable { let payload: Payload }
                struct Payload: Decodable { let message: CardMessage }
            }
            guard let frame = try? decoder.decode(Frame.self, from: data) else { return nil }
            return .messageCreated(message: frame.event.payload.message)

        default:
            // org_graph_updated / member_left: no iOS UI yet.
            return .ignored
        }
    }
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
