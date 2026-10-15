import Foundation

/// The harness (docs/kylon-gap-plan.md), from the phone: the workspace's
/// mode, and the Apps, Workflows, Approvals, Skills and agent profiles under
/// it. Every number and every view is the Worker's; the phone draws them.
/// A workspace in "simple" mode shows none of this.
enum HarnessService {
    enum Failure: LocalizedError {
        case notSignedIn
        case refused(String)
        case server(Int)

        var errorDescription: String? {
            switch self {
            case .notSignedIn: String(localized: "Sign in to use the harness.")
            case .refused(let message): message
            case .server(let code): String(localized: "The request failed (\(code)).")
            }
        }
    }

    enum Mode: String, Codable { case simple, harness }

    // MARK: - Shapes

    struct ModeState: Decodable { let mode: Mode; let canEdit: Bool }

    struct Column: Codable, Identifiable, Hashable {
        let id: String
        let name: String
        let type: String
        let options: [String]?
    }

    struct Table: Decodable, Identifiable {
        let id: String
        let name: String
        let columns: [Column]
    }

    struct Row: Decodable, Identifiable {
        let id: String
        let values: [String: JSONValue]
    }

    struct Metric: Decodable, Identifiable {
        let label: String
        let op: String
        let value: Double?
        var id: String { label }
    }

    struct Lane: Decodable, Identifiable {
        let key: String?
        let rows: [Row]
        var id: String { key ?? "—" }
    }

    /// One of an app's views, worked out by the Worker: a table's rows, a
    /// board's lanes, or a summary's numbers.
    struct Pane: Decodable, Identifiable {
        let id: String
        let type: String
        let name: String
        let groupBy: String?
        let rows: [Row]?
        let lanes: [Lane]?
        let values: [Metric]?
    }

    struct App: Decodable, Identifiable {
        let id: String
        let name: String
        let description: String
        let icon: String
        let tableId: String
        let version: Int
        let channels: [String]?
    }

    struct RenderedApp: Decodable {
        let app: App
        let table: Table
        let rows: [Row]
        let views: [Pane]
    }

    struct Template: Decodable, Identifiable {
        let id: String
        let name: String
        let icon: String
        let description: String
    }

    struct Version: Decodable, Identifiable {
        let version: Int
        let note: String?
        let createdAt: String
        var id: Int { version }
    }

    struct Trigger: Codable {
        var type: String
        var tableId: String?
        var on: String?
        var cadence: String?
        var hour: Int?
        var minute: Int?
        var timezone: String?
    }

    struct Step: Codable, Identifiable {
        var id = UUID()
        var type: String
        var channel: String?
        var text: String?
        var agentId: String?
        var prompt: String?
        var to: String?
        var title: String?
        var summary: String?
        var minutes: Int?

        private enum CodingKeys: String, CodingKey { case type, channel, text, agentId, prompt, to, title, summary, minutes }
    }

    struct Workflow: Decodable, Identifiable {
        let id: String
        let name: String
        let enabled: Bool
        let trigger: Trigger
        let steps: [Step]
        let nextRunAt: String?
        let hookUrl: String?
    }

    struct RunLog: Decodable, Identifiable {
        let step: Int
        let type: String
        let status: String
        let output: String?
        let error: String?
        var id: Int { step }
    }

    struct Run: Decodable, Identifiable {
        let id: String
        let trigger: String
        let status: String
        let log: [RunLog]
        let startedAt: String
    }

    struct WorkflowDetail: Decodable {
        let workflow: Workflow
        let runs: [Run]
        let canEdit: Bool
    }

    struct Approval: Decodable, Identifiable {
        let id: String
        let title: String
        let summary: String?
        let kind: String
        let source: String?
    }

    struct Waiting: Decodable, Identifiable {
        let runId: String
        let workflow: String
        let startedAt: String
        var id: String { runId }
    }

    struct Approvals: Decodable {
        let toDecide: [Approval]
        let waitingOnOthers: [Waiting]
    }

    struct Skill: Decodable, Identifiable {
        let id: String
        let name: String
        let description: String
        let body: String
    }

    struct Profile: Codable {
        var specialty: String
        var tier: String
        var mentionOnly: Bool
        var access: String
        var people: [String]
    }

    struct ProfileState: Decodable { let profile: Profile; let canEdit: Bool }

    struct Memory: Decodable, Identifiable {
        let id: String
        let text: String
        let createdAt: String
    }

    struct Followup: Decodable, Identifiable {
        let id: String
        let channel: String
        let instruction: String
        let dueAt: String
        let agentId: String?
    }

    struct Agent: Decodable, Identifiable {
        let id: String
        let handle: String
        let name: String
        let emoji: String?
        let description: String?
    }

    // MARK: - Calls

    /// One request: the session on it, the workspace in the query (a read)
    /// or the body (a write), the Worker's own words on a refusal.
    static func call<T: Decodable>(_ method: String, _ path: String, orgId: String, base: URL, body: [String: Any] = [:], query: [String: String] = [:], as type: T.Type = T.self) async throws -> T {
        guard let token = SessionStore.sessionToken else { throw Failure.notSignedIn }
        let read = method == "GET" || method == "DELETE"
        var components = URLComponents(url: base, resolvingAgainstBaseURL: true)
        components?.path = path
        if read {
            components?.queryItems = ([URLQueryItem(name: "orgId", value: orgId)] + query.sorted { $0.key < $1.key }.map { URLQueryItem(name: $0.key, value: $0.value) })
        }
        guard let url = components?.url else { throw Failure.server(0) }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = 30
        request.setValue(token, forHTTPHeaderField: "x-session-token")
        if !read {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            var payload = body
            payload["orgId"] = orgId
            request.httpBody = try JSONSerialization.data(withJSONObject: payload)
        }
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw Failure.server(0) }
        guard (200...299).contains(http.statusCode) else {
            if http.statusCode == 401 { throw Failure.notSignedIn }
            struct Refusal: Decodable { let message: String }
            if let refusal = try? JSONDecoder().decode(Refusal.self, from: data) {
                throw Failure.refused(refusal.message)
            }
            throw Failure.server(http.statusCode)
        }
        return try JSONDecoder().decode(T.self, from: data)
    }

    struct Done: Decodable {}

    static func mode(orgId: String, base: URL) async throws -> ModeState {
        try await call("GET", "/orgs/mode", orgId: orgId, base: base)
    }
    static func setMode(_ mode: Mode, orgId: String, base: URL) async throws -> ModeState {
        try await call("PUT", "/orgs/mode", orgId: orgId, base: base, body: ["mode": mode.rawValue])
    }

    static func apps(orgId: String, base: URL) async throws -> [App] {
        struct R: Decodable { let apps: [App] }
        return try await call("GET", "/apps", orgId: orgId, base: base, as: R.self).apps
    }
    static func templates(orgId: String, base: URL) async throws -> [Template] {
        struct R: Decodable { let templates: [Template] }
        return try await call("GET", "/apps/templates", orgId: orgId, base: base, as: R.self).templates
    }
    static func app(_ id: String, orgId: String, base: URL) async throws -> RenderedApp {
        try await call("GET", "/apps/\(id)", orgId: orgId, base: base)
    }
    static func fromTemplate(_ template: String, orgId: String, base: URL) async throws -> App {
        struct R: Decodable { let app: App }
        return try await call("POST", "/apps", orgId: orgId, base: base, body: ["template": template], as: R.self).app
    }
    static func generate(_ prompt: String, orgId: String, base: URL) async throws -> (app: App, fromModel: Bool) {
        struct R: Decodable { let app: App; let source: String }
        var body: [String: Any] = ["prompt": prompt]
        if let room = roomIn(prompt) { body["channel"] = "b:\(room)" }
        let r = try await call("POST", "/apps/generate", orgId: orgId, base: base, body: body, as: R.self)
        return (r.app, r.source == "model")
    }
    static func deleteApp(_ id: String, orgId: String, base: URL) async throws {
        _ = try await call("DELETE", "/apps/\(id)", orgId: orgId, base: base, as: Done.self)
    }
    static func versions(_ id: String, orgId: String, base: URL) async throws -> [Version] {
        struct R: Decodable { let versions: [Version] }
        return try await call("GET", "/apps/\(id)/versions", orgId: orgId, base: base, as: R.self).versions
    }
    static func restore(_ id: String, version: Int, orgId: String, base: URL) async throws {
        _ = try await call("POST", "/apps/\(id)/versions", orgId: orgId, base: base, body: ["version": version], as: Done.self)
    }
    static func link(_ id: String, channel: String, orgId: String, base: URL) async throws {
        _ = try await call("POST", "/apps/\(id)/links", orgId: orgId, base: base, body: ["channel": channel], as: Done.self)
    }

    static func addRow(table: String, values: [String: Any], orgId: String, base: URL) async throws {
        _ = try await call("POST", "/tables/\(table)/rows", orgId: orgId, base: base, body: ["values": values], as: Done.self)
    }
    static func updateRow(table: String, row: String, values: [String: Any], orgId: String, base: URL) async throws {
        _ = try await call("PATCH", "/tables/\(table)/rows/\(row)", orgId: orgId, base: base, body: ["values": values], as: Done.self)
    }
    static func deleteRow(table: String, row: String, orgId: String, base: URL) async throws {
        _ = try await call("DELETE", "/tables/\(table)/rows/\(row)", orgId: orgId, base: base, as: Done.self)
    }
    static func tables(orgId: String, base: URL) async throws -> [Table] {
        struct R: Decodable { let tables: [Table] }
        return try await call("GET", "/tables", orgId: orgId, base: base, as: R.self).tables
    }

    static func workflows(orgId: String, base: URL) async throws -> [Workflow] {
        struct R: Decodable { let workflows: [Workflow] }
        return try await call("GET", "/workflows", orgId: orgId, base: base, as: R.self).workflows
    }
    static func workflow(_ id: String, orgId: String, base: URL) async throws -> WorkflowDetail {
        try await call("GET", "/workflows/\(id)", orgId: orgId, base: base)
    }
    static func createWorkflow(name: String, trigger: Trigger, steps: [Step], orgId: String, base: URL) async throws -> String? {
        struct R: Decodable { let hookUrl: String? }
        let encoder = JSONEncoder()
        let triggerJSON = try JSONSerialization.jsonObject(with: try encoder.encode(trigger))
        let stepsJSON = try JSONSerialization.jsonObject(with: try encoder.encode(steps))
        return try await call("POST", "/workflows", orgId: orgId, base: base, body: ["name": name, "trigger": triggerJSON, "steps": stepsJSON], as: R.self).hookUrl
    }
    static func setWorkflowEnabled(_ id: String, _ enabled: Bool, orgId: String, base: URL) async throws {
        _ = try await call("PUT", "/workflows/\(id)", orgId: orgId, base: base, body: ["enabled": enabled], as: Done.self)
    }
    static func runWorkflow(_ id: String, orgId: String, base: URL) async throws {
        _ = try await call("POST", "/workflows/\(id)/run", orgId: orgId, base: base, body: ["text": ""], as: Done.self)
    }
    static func deleteWorkflow(_ id: String, orgId: String, base: URL) async throws {
        _ = try await call("DELETE", "/workflows/\(id)", orgId: orgId, base: base, as: Done.self)
    }

    static func approvals(orgId: String, base: URL) async throws -> Approvals {
        try await call("GET", "/approvals", orgId: orgId, base: base)
    }

    static func skills(orgId: String, base: URL) async throws -> [Skill] {
        struct R: Decodable { let skills: [Skill] }
        return try await call("GET", "/skills", orgId: orgId, base: base, as: R.self).skills
    }
    static func saveSkill(id: String?, name: String, description: String, body: String, orgId: String, base: URL) async throws {
        let payload: [String: Any] = ["name": name, "description": description, "body": body]
        if let id { _ = try await call("PUT", "/skills/\(id)", orgId: orgId, base: base, body: payload, as: Done.self) }
        else { _ = try await call("POST", "/skills", orgId: orgId, base: base, body: payload, as: Done.self) }
    }
    static func deleteSkill(_ id: String, orgId: String, base: URL) async throws {
        _ = try await call("DELETE", "/skills/\(id)", orgId: orgId, base: base, as: Done.self)
    }

    static func agents(orgId: String, base: URL) async throws -> [Agent] {
        struct R: Decodable { let agents: [Agent] }
        return try await call("GET", "/channels/agents", orgId: orgId, base: base, as: R.self).agents
    }
    static func profile(agent: String, orgId: String, base: URL) async throws -> ProfileState {
        try await call("GET", "/hx/agents/\(agent)/profile", orgId: orgId, base: base)
    }
    static func saveProfile(agent: String, _ p: Profile, orgId: String, base: URL) async throws {
        let body: [String: Any] = ["specialty": p.specialty, "tier": p.tier, "mentionOnly": p.mentionOnly, "access": p.access, "people": p.people]
        _ = try await call("PUT", "/hx/agents/\(agent)/profile", orgId: orgId, base: base, body: body, as: Done.self)
    }
    static func memory(agent: String, orgId: String, base: URL) async throws -> [Memory] {
        struct R: Decodable { let memories: [Memory] }
        return try await call("GET", "/hx/agents/\(agent)/memory", orgId: orgId, base: base, as: R.self).memories
    }
    static func remember(agent: String, text: String, orgId: String, base: URL) async throws {
        _ = try await call("POST", "/hx/agents/\(agent)/memory", orgId: orgId, base: base, body: ["text": text], as: Done.self)
    }
    static func forget(agent: String, memory: String, orgId: String, base: URL) async throws {
        _ = try await call("DELETE", "/hx/agents/\(agent)/memory", orgId: orgId, base: base, query: ["id": memory], as: Done.self)
    }
    static func agentSkills(agent: String, orgId: String, base: URL) async throws -> [Skill] {
        struct R: Decodable { let skills: [Skill] }
        return try await call("GET", "/hx/agents/\(agent)/skills", orgId: orgId, base: base, as: R.self).skills
    }
    static func setSkill(agent: String, skill: String, on: Bool, orgId: String, base: URL) async throws {
        if on { _ = try await call("POST", "/hx/agents/\(agent)/skills", orgId: orgId, base: base, body: ["skillId": skill], as: Done.self) }
        else { _ = try await call("DELETE", "/hx/agents/\(agent)/skills", orgId: orgId, base: base, query: ["skillId": skill], as: Done.self) }
    }
    static func followups(orgId: String, base: URL) async throws -> [Followup] {
        struct R: Decodable { let followups: [Followup] }
        return try await call("GET", "/followups", orgId: orgId, base: base, as: R.self).followups
    }
    static func cancelFollowup(_ id: String, orgId: String, base: URL) async throws {
        _ = try await call("DELETE", "/followups/\(id)", orgId: orgId, base: base, as: Done.self)
    }

    // MARK: - Reading what came back

    /// "#ops" in a sentence, without the mark.
    static func roomIn(_ text: String) -> String? {
        guard let range = text.range(of: #"#[\p{L}\p{N}_-]+"#, options: .regularExpression) else { return nil }
        return String(text[range].dropFirst())
    }

    /// A cell as the table shows it.
    static func cellText(_ column: Column, _ value: JSONValue?) -> String {
        guard let value else { return "" }
        switch (column.type, value) {
        case ("checkbox", .bool(let on)): return on ? "✓" : ""
        case ("person", .string(let login)): return "@\(login)"
        case ("number", .number(let n)): return number(n)
        default: return value.text
        }
    }

    static func metricText(_ m: Metric) -> String {
        guard let v = m.value else { return "—" }
        return number(v)
    }

    static func number(_ n: Double) -> String {
        let f = NumberFormatter()
        f.numberStyle = .decimal
        f.maximumFractionDigits = 2
        return f.string(from: NSNumber(value: n)) ?? String(n)
    }

    /// What a typed field means for its column, in the Worker's terms.
    static func value(for column: Column, from text: String) -> Any {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return NSNull() }
        switch column.type {
        case "number": return Double(trimmed.replacingOccurrences(of: ",", with: "")) ?? NSNull()
        case "checkbox": return ["true", "yes", "1", "✓"].contains(trimmed.lowercased())
        default: return trimmed
        }
    }

    static func date(_ iso: String) -> Date? {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.date(from: iso) ?? ISO8601DateFormatter().date(from: iso)
    }
}

/// Any JSON value: a row's cells are text, numbers, dates, booleans or
/// nothing, by the column.
enum JSONValue: Codable, Hashable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case null

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let b = try? c.decode(Bool.self) { self = .bool(b) }
        else if let n = try? c.decode(Double.self) { self = .number(n) }
        else if let s = try? c.decode(String.self) { self = .string(s) }
        else { self = .null }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .string(let s): try c.encode(s)
        case .number(let n): try c.encode(n)
        case .bool(let b): try c.encode(b)
        case .null: try c.encodeNil()
        }
    }

    var text: String {
        switch self {
        case .string(let s): s
        case .number(let n): n.rounded() == n && abs(n) < 1e15 ? String(Int(n)) : String(n)
        case .bool(let b): b ? "✓" : ""
        case .null: ""
        }
    }
}
