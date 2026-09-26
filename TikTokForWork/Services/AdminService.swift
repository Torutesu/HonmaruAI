import Foundation

/// What a workspace's admins look after, read from the phone: its data rules
/// (which they can also switch on and off here), and how its compliance
/// settings, single sign-on and audit streams stand. Changing the rest takes
/// an owner's fresh sign-in, which is the web's (Studio).
enum AdminService {
    // MARK: Data rules

    struct DataRule: Identifiable, Decodable, Equatable {
        let id: String
        let name: String
        let kind: String
        let detector: String?
        let pattern: String?
        let keywords: [String]?
        let action: String
        let enabled: Bool
    }

    struct Detector: Identifiable, Decodable, Equatable {
        let id: String
        let name: String
    }

    struct DataRules: Decodable {
        let rules: [DataRule]
        let detectors: [Detector]
        let canEdit: Bool
    }

    static func dataRules(orgId: String, base: URL) async throws -> DataRules {
        try await ChatService.call("GET", "/orgs/dlp", base: base, query: ["orgId": orgId], as: DataRules.self)
    }

    private struct Saved: Decodable { let rule: DataRule? }
    private struct Nothing: Decodable {}

    /// One of the ready-made detectors, or a list of words, as a new rule.
    static func addRule(orgId: String, detector: String?, keywords: [String], name: String, action: String, base: URL) async throws {
        var body: [String: Any] = ["orgId": orgId, "action": action]
        if let detector {
            body["kind"] = "builtin"; body["detector"] = detector
        } else {
            body["kind"] = "keywords"; body["keywords"] = keywords.joined(separator: "\n"); body["name"] = name
        }
        _ = try await ChatService.call("POST", "/orgs/dlp", base: base, body: body, as: Saved.self)
    }

    static func setRule(_ id: String, enabled: Bool? = nil, action: String? = nil, orgId: String, base: URL) async throws {
        var body: [String: Any] = ["orgId": orgId]
        if let enabled { body["enabled"] = enabled }
        if let action { body["action"] = action }
        _ = try await ChatService.call("PATCH", "/orgs/dlp/\(id)", base: base, body: body, as: Saved.self)
    }

    static func deleteRule(_ id: String, orgId: String, base: URL) async throws {
        _ = try await ChatService.call("DELETE", "/orgs/dlp/\(id)", base: base, query: ["orgId": orgId], as: Nothing.self)
    }

    // MARK: Compliance

    struct Governance: Decodable {
        struct Retention: Decodable { let publicDays: Int?; let privateDays: Int?; let dmDays: Int?; let filesDays: Int? }
        struct Network: Decodable { let enforce: Bool; let allowlist: [String] }
        struct Invites: Decodable { let policy: String; let guestsExempt: Bool }
        let retention: Retention
        let network: Network
        let invites: Invites
    }

    struct Hold: Identifiable, Decodable {
        struct Target: Decodable { let name: String?; let channel: String? }
        let id: String
        let kind: String
        let reason: String
        let createdAt: String
        let releasedAt: String?
        let target: Target
    }

    struct ComplianceExport: Identifiable, Decodable {
        let id: String
        let status: String
        let createdAt: String
        let expiresAt: String?
    }

    static func governance(orgId: String, base: URL) async throws -> Governance {
        try await ChatService.call("GET", "/orgs/governance", base: base, query: ["orgId": orgId], as: Governance.self)
    }

    static func holds(orgId: String, base: URL) async throws -> [Hold] {
        struct R: Decodable { let holds: [Hold] }
        return try await ChatService.call("GET", "/orgs/holds", base: base, query: ["orgId": orgId], as: R.self).holds
    }

    static func exports(orgId: String, base: URL) async throws -> [ComplianceExport] {
        struct R: Decodable { let exports: [ComplianceExport] }
        return try await ChatService.call("GET", "/orgs/compliance/exports", base: base, query: ["orgId": orgId], as: R.self).exports
    }

    // MARK: Single sign-on and audit streams

    struct Connection: Identifiable, Decodable {
        let id: String
        let name: String
        let provider: String
        let allowedDomains: [String]
        let status: String
        let testedAt: String?
        let logoutUrl: String?
    }

    struct SSO: Decodable {
        let connections: [Connection]
        let enforce: Bool
    }

    struct Stream: Identifiable, Decodable {
        let id: String
        let kind: String
        let endpoint: String?
        let status: String
        let failures: Int?
        let lastError: String?
        let lastSentAt: String?
    }

    static func sso(orgId: String, base: URL) async throws -> SSO {
        try await ChatService.call("GET", "/orgs/sso", base: base, query: ["orgId": orgId], as: SSO.self)
    }

    static func streams(orgId: String, base: URL) async throws -> [Stream] {
        struct R: Decodable { let streams: [Stream] }
        return try await ChatService.call("GET", "/audit/streams", base: base, query: ["orgId": orgId], as: R.self).streams
    }

    /// Days as a person reads them: "Forever", "30 days", "1 year".
    static func days(_ value: Int?) -> String {
        guard let value else { return String(localized: "Forever") }
        if value >= 365, value % 365 == 0 {
            let years = value / 365
            return years == 1 ? String(localized: "1 year") : String(localized: "\(years) years")
        }
        return value == 1 ? String(localized: "1 day") : String(localized: "\(value) days")
    }
}
