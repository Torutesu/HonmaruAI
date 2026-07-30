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
            self = .error(message: "Unknown event: \(type)")
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

enum OutboundEvent {
    case join(userId: String, orgId: String, token: String?)
    case cardCreated(DecisionCard)
    case cardUpdated(DecisionCard)
    case cardDeleted(cardID: String, recipientUserID: String)
    case clearStore

    var envelope: [String: Any] {
        switch self {
        case .join(let userId, let orgId, let token):
            var payload: [String: Any] = ["userId": userId, "orgId": orgId]
            if let token, !token.isEmpty {
                payload["token"] = token
            }
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
        case .clearStore:
            return ["type": "clear_store", "payload": [:]]
        }
    }
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
    private var lastUserID: String?
    private var lastOrgID = "core-team"
    private var lastToken: String?
    private let session = URLSession(configuration: .default)
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

    func connect(
        urlString: String,
        userId: String,
        orgId: String = "core-team",
        token: String? = nil
    ) async throws {
        intentionalDisconnect = false
        lastURLString = urlString
        lastUserID = userId
        lastOrgID = orgId
        lastToken = token
        disconnect(intentional: true)

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

        try await send(.join(userId: userId, orgId: orgId, token: token))
        isConnected = true
    }

    func disconnect(intentional: Bool = false) {
        intentionalDisconnect = intentional
        reconnectTask?.cancel()
        reconnectTask = nil
        receiveLoopTask?.cancel()
        receiveLoopTask = nil
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        isConnected = false
        onlineUserIDs = []
    }

    func publishCreated(_ card: DecisionCard) async {
        try? await send(.cardCreated(card))
    }

    func publishUpdated(_ card: DecisionCard) async {
        try? await send(.cardUpdated(card))
    }

    func publishDeleted(cardID: String, recipientUserID: String) async {
        try? await send(.cardDeleted(cardID: cardID, recipientUserID: recipientUserID))
    }

    func publishClearStore() async {
        try? await send(.clearStore)
    }

    private func send(_ event: OutboundEvent) async throws {
        guard let task else { throw URLError(.notConnectedToInternet) }
        let data = try JSONSerialization.data(withJSONObject: event.envelope)
        guard let text = String(data: data, encoding: .utf8) else { return }
        try await task.send(.string(text))
    }

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
              let lastUserID else { return }

        reconnectTask?.cancel()
        reconnectTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(2))
            guard let self, !Task.isCancelled, !self.intentionalDisconnect else { return }
            try? await self.connect(
                urlString: lastURLString,
                userId: lastUserID,
                orgId: self.lastOrgID,
                token: self.lastToken
            )
        }
    }

    private func handle(text: String) {
        guard let data = text.data(using: .utf8),
              let event = try? decoder.decode(RealtimeEvent.self, from: data) else {
            return
        }

        if case .presence(let userId, let status) = event {
            if status == "online" {
                onlineUserIDs.insert(userId)
            } else {
                onlineUserIDs.remove(userId)
            }
        }

        onEvent?(event)
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
