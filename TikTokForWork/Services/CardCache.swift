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

    /// The current format retains a separate feed for every organization this
    /// account has opened. This lets a person switch repositories and come back
    /// offline without ever showing one team's cards in another team's feed.
    private struct Store: Codable {
        let version: Int
        var cardsByOrganization: [String: [String: [DecisionCard]]]
    }

    /// The format shipped before multi-org caching. Keep it private and decode
    /// it only as a migration path, so an app update does not turn a useful
    /// offline feed into a blank one.
    private struct LegacyEnvelope: Codable {
        let orgID: String
        let cardsByUser: [String: [DecisionCard]]
    }

    static func load(orgID: String) -> [String: [DecisionCard]] {
        guard let fileURL, let data = try? Data(contentsOf: fileURL) else { return [:] }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        if let store = try? decoder.decode(Store.self, from: data) {
            return store.cardsByOrganization[orgID, default: [:]]
        }
        if let legacy = try? decoder.decode(LegacyEnvelope.self, from: data), legacy.orgID == orgID {
            return legacy.cardsByUser
        }
        return [:]
    }

    static func save(orgID: String, cardsByUser: [String: [DecisionCard]]) {
        guard let fileURL else { return }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        var organizations: [String: [String: [DecisionCard]]] = [:]
        if let data = try? Data(contentsOf: fileURL),
           let store = try? decoder.decode(Store.self, from: data) {
            organizations = store.cardsByOrganization
        } else if let data = try? Data(contentsOf: fileURL),
                  let legacy = try? decoder.decode(LegacyEnvelope.self, from: data) {
            organizations[legacy.orgID] = legacy.cardsByUser
        }
        organizations[orgID] = cardsByUser

        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        guard let data = try? encoder.encode(Store(version: 2, cardsByOrganization: organizations)) else { return }
        try? data.write(to: fileURL, options: .atomic)
    }

    static func clear() {
        guard let fileURL else { return }
        try? FileManager.default.removeItem(at: fileURL)
    }
}
