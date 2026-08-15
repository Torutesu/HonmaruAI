import Foundation

/// The last known feed, on disk.
///
/// The store used to live only in memory, so a cold launch showed nothing until
/// the socket connected — and on a plane, or in a basement, that is never. For a
/// product whose whole pitch is "open it and the decision is already there", an
/// empty first screen is the pitch failing.
///
/// The cache is a mirror, never a source of truth: a relay snapshot replaces it
/// wholesale. It exists to fill the second between launch and sync, and to be
/// the entire feed when there is no network at all.
@MainActor
enum CardCache {
    private static let filename = "cards.json"

    private static var fileURL: URL? {
        guard let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else {
            return nil
        }
        let directory = base.appendingPathComponent("Honmaru", isDirectory: true)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory.appendingPathComponent(filename)
    }

    /// Cards are cached per organization. Reading another org's cache after a
    /// repository switch would show decisions that are not this team's.
    private struct Envelope: Codable {
        let orgID: String
        let cardsByUser: [String: [DecisionCard]]
    }

    static func load(orgID: String) -> [String: [DecisionCard]] {
        guard let fileURL, let data = try? Data(contentsOf: fileURL) else { return [:] }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        guard let envelope = try? decoder.decode(Envelope.self, from: data),
              envelope.orgID == orgID else { return [:] }
        return envelope.cardsByUser
    }

    static func save(orgID: String, cardsByUser: [String: [DecisionCard]]) {
        guard let fileURL else { return }
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        guard let data = try? encoder.encode(Envelope(orgID: orgID, cardsByUser: cardsByUser)) else { return }
        try? data.write(to: fileURL, options: .atomic)
    }

    static func clear() {
        guard let fileURL else { return }
        try? FileManager.default.removeItem(at: fileURL)
    }
}
