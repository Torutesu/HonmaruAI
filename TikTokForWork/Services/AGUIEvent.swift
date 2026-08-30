import Foundation

/// Decodes the relay's AG-UI event stream (`protocol: "agui/1"`) into the
/// app's existing `RealtimeEvent` vocabulary, so `DecisionCardService` and
/// everything above it stay untouched.
///
/// Shapes handled (see docs/agui-protocol.md):
/// - STATE_SNAPSHOT  { snapshot: { cardsById: { id: card } } }
/// - STATE_DELTA     { delta: [ { op, path: "/cardsById/<id>", value? } ] }
/// - TOOL_CALL_START / TOOL_CALL_ARGS / TOOL_CALL_END  (request_decision;
///   args arrive as chunked JSON string deltas and are buffered until END)
/// - TOOL_CALL_RESULT (echo of another device's decision — state patch follows,
///   so it is ignored here)
/// - CUSTOM { name: "presence", value: { userId, status } }
/// - RUN_STARTED / RUN_FINISHED / RUN_ERROR
final class AGUIEventAssembler {

    /// toolCallId per card, kept so a future outbound `tool_result` can
    /// reference the call that asked for the decision.
    private(set) var toolCallIDsByCard: [String: String] = [:]

    private var pendingCallNames: [String: String] = [:]
    private var pendingCallArgs: [String: String] = [:]

    private let decoder: JSONDecoder

    init(decoder: JSONDecoder) {
        self.decoder = decoder
    }

    /// Returns true when the payload looks like an AG-UI event rather than a
    /// legacy `{type, payload}` relay message.
    static func isAGUIEvent(_ json: [String: Any]) -> Bool {
        guard let type = json["type"] as? String else { return false }
        switch type {
        case "RUN_STARTED", "RUN_FINISHED", "RUN_ERROR",
             "STATE_SNAPSHOT", "STATE_DELTA",
             "TOOL_CALL_START", "TOOL_CALL_ARGS", "TOOL_CALL_END",
             "TOOL_CALL_RESULT", "CUSTOM",
             "TEXT_MESSAGE_START", "TEXT_MESSAGE_CONTENT", "TEXT_MESSAGE_END":
            return true
        default:
            return false
        }
    }

    func handle(_ json: [String: Any]) -> [RealtimeEvent] {
        guard let type = json["type"] as? String else { return [] }

        switch type {
        case "STATE_SNAPSHOT":
            guard let snapshot = json["snapshot"] as? [String: Any],
                  let cardsById = snapshot["cardsById"] as? [String: Any] else {
                return []
            }
            var cardsByUser: [String: [DecisionCard]] = [:]
            for value in cardsById.values {
                guard let card = decodeCard(value) else { continue }
                cardsByUser[card.recipientUserID, default: []].append(card)
            }
            for key in cardsByUser.keys {
                cardsByUser[key]?.sort { $0.createdAt > $1.createdAt }
            }
            return [.snapshot(cardsByUser: cardsByUser)]

        case "STATE_DELTA":
            guard let delta = json["delta"] as? [[String: Any]] else { return [] }
            return delta.compactMap { applyOperation($0) }

        case "TOOL_CALL_START":
            guard let id = json["toolCallId"] as? String,
                  let name = json["toolCallName"] as? String else { return [] }
            pendingCallNames[id] = name
            pendingCallArgs[id] = ""
            return []

        case "TOOL_CALL_ARGS":
            guard let id = json["toolCallId"] as? String,
                  let chunk = json["delta"] as? String else { return [] }
            pendingCallArgs[id, default: ""] += chunk
            return []

        case "TOOL_CALL_END":
            guard let id = json["toolCallId"] as? String else { return [] }
            let name = pendingCallNames.removeValue(forKey: id)
            let args = pendingCallArgs.removeValue(forKey: id) ?? ""
            guard name == "request_decision",
                  let data = args.data(using: .utf8),
                  let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let card = decodeCard(parsed["card"] as Any) else {
                return []
            }
            toolCallIDsByCard[card.id] = id
            // The recipient also receives the STATE_DELTA add for this card;
            // upsert-by-id downstream makes the duplicate harmless.
            return [.cardCreated(card: card)]

        case "CUSTOM":
            guard json["name"] as? String == "presence",
                  let value = json["value"] as? [String: Any],
                  let userId = value["userId"] as? String,
                  let status = value["status"] as? String else { return [] }
            return [.presence(userId: userId, status: status)]

        case "RUN_ERROR":
            return [.error(message: json["message"] as? String ?? "AG-UI run error")]

        default:
            // RUN_STARTED / RUN_FINISHED / TOOL_CALL_RESULT / text events —
            // nothing for the card store to do.
            return []
        }
    }

    private func applyOperation(_ operation: [String: Any]) -> RealtimeEvent? {
        guard let op = operation["op"] as? String,
              let path = operation["path"] as? String,
              let cardID = Self.cardID(fromPointer: path) else {
            return nil
        }

        switch op {
        case "add", "replace":
            guard let card = decodeCard(operation["value"] as Any) else { return nil }
            return op == "add" ? .cardCreated(card: card) : .cardUpdated(card: card)
        case "remove":
            // Recipient is resolved by the socket layer, which tracks card
            // ownership from snapshots and upserts.
            return .cardDeleted(cardID: cardID, recipientUserID: "")
        default:
            return nil
        }
    }

    /// "/cardsById/a~1b~0c" → "a/b~c" (RFC 6901 unescaping).
    static func cardID(fromPointer pointer: String) -> String? {
        let prefix = "/cardsById/"
        guard pointer.hasPrefix(prefix) else { return nil }
        let escaped = String(pointer.dropFirst(prefix.count))
        guard !escaped.isEmpty, !escaped.contains("/") else { return nil }
        return escaped
            .replacingOccurrences(of: "~1", with: "/")
            .replacingOccurrences(of: "~0", with: "~")
    }

    /// A card we cannot read is skipped rather than allowed to take the whole
    /// snapshot down with it — but skipped silently is a decision that never
    /// arrives and that nobody is told about, so it is at least written down.
    private func decodeCard(_ value: Any) -> DecisionCard? {
        guard let data = try? JSONSerialization.data(withJSONObject: value) else { return nil }
        do {
            return try decoder.decode(DecisionCard.self, from: data)
        } catch {
            let id = (value as? [String: Any])?["id"] as? String ?? "unknown"
            print("AGUIEventAssembler: dropped card \(id) — \(error)")
            return nil
        }
    }
}
