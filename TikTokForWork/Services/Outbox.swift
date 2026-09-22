import CryptoKit
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
/// Order is preserved because a decision followed by a rollback is not the same
/// story told backwards. A completed transport write is not a persistence
/// receipt: the current relay protocol cannot guarantee exactly-once delivery.
@MainActor
final class Outbox {
    private var pending: [Entry] = []
    private let fileURL: URL?
    private var isFlushing = false

    struct Entry: Codable {
        let id: UUID
        let envelope: Data          // the JSON we would have sent
        let queuedAt: Date
    }

    /// A pending decision belongs to one account, organization and relay.
    /// Hashing avoids unsafe path characters and putting account names in filenames.
    static func filename(relayURL: String, userID: String, orgID: String) -> String {
        "\(accountPrefix(relayURL: relayURL, userID: userID))\(digest([orgID])).json"
    }

    static func clearAll(relayURL: String, userID: String) {
        guard let directory = supportDirectory(),
              let files = try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil) else { return }
        let prefix = accountPrefix(relayURL: relayURL, userID: userID)
        for file in files where file.lastPathComponent.hasPrefix(prefix) && file.pathExtension == "json" {
            try? FileManager.default.removeItem(at: file)
        }
    }

    private static func accountPrefix(relayURL: String, userID: String) -> String {
        "outbox-\(digest([relayURL, userID]))-"
    }

    private static func digest(_ components: [String]) -> String {
        let data = (try? JSONEncoder().encode(components)) ?? Data()
        return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    init(filename: String = "outbox.json") {
        fileURL = Outbox.supportDirectory()?.appendingPathComponent(filename)
        load()
    }

    var count: Int { pending.count }
    var events: [OutboundEvent] { pending.compactMap(Outbox.decode) }

    func append(_ event: OutboundEvent) {
        // A join contains a credential. Refuse it even if a new caller bypasses
        // the socket's normal join path, including a replayed raw envelope.
        guard event.envelope["type"] as? String != "join" else { return }
        guard let data = try? JSONSerialization.data(withJSONObject: event.envelope) else { return }
        pending.append(Entry(id: UUID(), envelope: data, queuedAt: .now))
        persist()
    }

    /// Keep the current event and every later event on disk until send succeeds.
    /// Removing the whole queue before sending lost its tail on the first error
    /// and lost every item if iOS terminated the app during an in-flight send.
    func flush(using send: (OutboundEvent) async throws -> Void) async throws {
        guard !isFlushing else { return }
        isFlushing = true
        defer { isFlushing = false }
        while let entry = pending.first, let event = Outbox.decode(entry) {
            try Task.checkCancellation()
            try await send(event)
            // A sign-out can clear the queue while the transport is suspended.
            guard pending.first?.id == entry.id else { return }
            pending.removeFirst()
            persist()
        }
    }

    func clear() {
        pending = []
        persist()
    }

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
