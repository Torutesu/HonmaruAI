import Foundation

/// Mutations that could not be sent, kept until they can be.
///
/// Before this existed, publishing was `try?`. With no socket the send threw,
/// the error was thrown away, and the decision lived only on the device that
/// made it — the person saw success and the teammate waiting on it never heard.
/// That is the worst failure this product has: it is silent, and it looks
/// exactly like working.
///
/// The queue is on disk because the failure it exists for is "no network", and
/// the very next thing that usually happens is the app being killed.
///
/// Re-delivery is safe by construction: every message the relay accepts is an
/// upsert keyed by card id, so sending the same decision twice is the same as
/// sending it once. Order is preserved because a decision followed by a rollback
/// is not the same story told backwards.
@MainActor
final class Outbox {
    private var pending: [Entry] = []
    private let fileURL: URL?
    private let limit = 200

    struct Entry: Codable {
        let envelope: Data          // the JSON we would have sent
        let queuedAt: Date
    }

    init(filename: String = "outbox.json") {
        fileURL = Outbox.supportDirectory()?.appendingPathComponent(filename)
        load()
    }

    var count: Int { pending.count }

    func append(_ event: OutboundEvent) {
        guard let data = try? JSONSerialization.data(withJSONObject: event.envelope) else { return }
        pending.append(Entry(envelope: data, queuedAt: .now))
        // A queue that grows without bound on a device that has been offline for
        // a week is a disk problem, not a delivery guarantee. The oldest go
        // first: the newest state of a card is the one worth delivering.
        if pending.count > limit { pending.removeFirst(pending.count - limit) }
        persist()
    }

    /// Everything queued, oldest first, removed from the queue. A caller that
    /// cannot deliver one puts it back with `prepend`.
    func drain() -> [OutboundEvent] {
        let entries = pending
        pending = []
        persist()
        return entries.compactMap(Outbox.decode)
    }

    func prepend(_ event: OutboundEvent) {
        guard let data = try? JSONSerialization.data(withJSONObject: event.envelope) else { return }
        pending.insert(Entry(envelope: data, queuedAt: .now), at: 0)
        persist()
    }

    func clear() {
        pending = []
        persist()
    }

    /// The cards in the queue that the relay has not seen yet, oldest first.
    ///
    /// A join snapshot is the server's whole truth, and adopting it used to
    /// mean discarding a decision made offline seconds earlier — so the app
    /// refused any empty snapshot instead, which left a device showing cards
    /// its organization had deleted. These are what makes taking the snapshot
    /// safe: the local changes still in flight, re-applied on top of it, so the
    /// feed is the server's answer plus your own unsent work and nothing else.
    func unsentCards() -> [DecisionCard] {
        pending.compactMap { entry -> DecisionCard? in
            guard let object = try? JSONSerialization.jsonObject(with: entry.envelope) as? [String: Any],
                  let type = object["type"] as? String,
                  type == "card_created" || type == "card_updated",
                  let payload = object["payload"] as? [String: Any],
                  let card = payload["card"]
            else { return nil }
            guard let data = try? JSONSerialization.data(withJSONObject: card) else { return nil }
            return try? Outbox.cardDecoder.decode(DecisionCard.self, from: data)
        }
    }

    /// Cards deleted locally whose deletion has not reached the relay. Without
    /// these a snapshot would put a deleted card back on screen.
    func unsentDeletions() -> Set<String> {
        var ids: Set<String> = []
        for entry in pending {
            guard let object = try? JSONSerialization.jsonObject(with: entry.envelope) as? [String: Any],
                  object["type"] as? String == "card_deleted",
                  let payload = object["payload"] as? [String: Any],
                  let id = payload["cardId"] as? String
            else { continue }
            ids.insert(id)
        }
        return ids
    }

    /// Matches how cards are written into the queue: ISO 8601, fractional
    /// seconds or not.
    private nonisolated static let cardDecoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let value = try container.decode(String.self)
            for formatter in [ISO8601DateFormatter.fractional, ISO8601DateFormatter.standard] {
                if let date = formatter.date(from: value) { return date }
            }
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "Invalid date: \(value)")
        }
        return decoder
    }()

    // MARK: - Storage

    /// Nonisolated so it can be passed to `compactMap` as a plain function.
    /// It touches no instance state, so there is nothing for the actor to guard.
    private nonisolated static func decode(_ entry: Entry) -> OutboundEvent? {
        guard let object = try? JSONSerialization.jsonObject(with: entry.envelope) as? [String: Any] else {
            return nil
        }
        return .raw(object)
    }

    private nonisolated static func supportDirectory() -> URL? {
        guard let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else {
            return nil
        }
        let directory = base.appendingPathComponent("Honmaru", isDirectory: true)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory
    }

    private func load() {
        guard let fileURL, let data = try? Data(contentsOf: fileURL) else { return }
        pending = (try? JSONDecoder().decode([Entry].self, from: data)) ?? []
    }

    private func persist() {
        guard let fileURL else { return }
        guard let data = try? JSONEncoder().encode(pending) else { return }
        // Losing the queue is bad; crashing the app over it is worse.
        try? data.write(to: fileURL, options: .atomic)
    }
}
