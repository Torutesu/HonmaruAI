import Foundation

enum RealtimeEvent: Codable {
    case snapshot(cardsByUser: [String: [DecisionCard]])
    case cardCreated(card: DecisionCard)
    case cardUpdated(card: DecisionCard)
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

    private struct PresencePayload: Codable {
        let userId: String
        let status: String
    }

    private struct ErrorPayload: Codable {
        let message: String
    }
}

enum OutboundEvent {
    case join(userId: String, orgId: String)
    case cardCreated(DecisionCard)
    case cardUpdated(DecisionCard)

    var envelope: [String: Any] {
        switch self {
        case .join(let userId, let orgId):
            return ["type": "join", "payload": ["userId": userId, "orgId": orgId]]
        case .cardCreated(let card):
            return ["type": "card_created", "payload": ["card": card.dictionary]]
        case .cardUpdated(let card):
            return ["type": "card_updated", "payload": ["card": card.dictionary]]
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

    func connect(urlString: String, userId: String, orgId: String = "core-team") async throws {
        disconnect()

        guard let url = URL(string: urlString) else {
            throw URLError(.badURL)
        }

        var request = URLRequest(url: url)
        request.timeoutInterval = 10

        let task = session.webSocketTask(with: request)
        self.task = task
        task.resume()
        isConnected = true

        receiveLoopTask = Task { [weak self] in
            await self?.receiveLoop()
        }

        try await send(.join(userId: userId, orgId: orgId))
    }

    func disconnect() {
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
                break
            }
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
