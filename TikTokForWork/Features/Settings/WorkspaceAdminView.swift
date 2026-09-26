import SwiftUI

/// The workspace's admin screens on the phone (docs/enterprise-audit-log.md
/// §10): data rules, which an admin can switch on and off, add and remove
/// here; and how compliance, single sign-on and the audit streams stand.
/// Settings that need an owner's fresh sign-in are changed on the web.
struct WorkspaceAdminView: View {
    @EnvironmentObject private var appState: AppState

    var body: some View {
        List {
            Section {
                NavigationLink { DataRulesAdminView().environmentObject(appState) } label: {
                    Label("Data rules", systemImage: "shield.lefthalf.filled")
                }
                NavigationLink { ComplianceAdminView().environmentObject(appState) } label: {
                    Label("Compliance", systemImage: "archivebox")
                }
                NavigationLink { SignOnAdminView().environmentObject(appState) } label: {
                    Label("Single sign-on and audit streams", systemImage: "key.horizontal")
                }
            } footer: {
                Text("Only admins and owners see these. Settings that need an owner to sign in again are changed on the web, in Studio.")
            }
        }
        .navigationTitle("Workspace admin").navigationBarTitleDisplayMode(.inline)
    }
}

/// Loading, and a refusal said as a sentence, for each admin screen.
private struct AdminLoad: ViewModifier {
    let error: String?
    let loaded: Bool
    let reload: () async -> Void

    func body(content: Content) -> some View {
        content
            .overlay { if !loaded { ProgressView() } }
            .safeAreaInset(edge: .bottom) {
                if let error {
                    Text(error).font(.footnote).foregroundStyle(Theme.Colors.reject)
                        .padding(12).frame(maxWidth: .infinity).background(.thinMaterial)
                }
            }
            .refreshable { await reload() }
            .task { await reload() }
    }
}

private extension AdminService {
    static var context: (orgId: String, base: URL)? {
        guard let orgId = SessionStore.orgId, !orgId.isEmpty,
              let base = BackendURL.httpBase(from: AppConfig.relayURL) else { return nil }
        return (orgId, base)
    }
}

// MARK: - Data rules

struct DataRulesAdminView: View {
    @State private var rules: [AdminService.DataRule] = []
    @State private var detectors: [AdminService.Detector] = []
    @State private var canEdit = false
    @State private var loaded = false
    @State private var error: String?
    @State private var adding = false

    var body: some View {
        List {
            Section {
                if loaded && rules.isEmpty { Text("No data rules yet.").foregroundStyle(Theme.Colors.textSecondary) }
                ForEach(rules) { rule in
                    DataRuleRow(rule: rule, canEdit: canEdit) { enabled in
                        Task { await change(rule, enabled: enabled) }
                    }
                    .swipeActions {
                        if canEdit {
                            Button(role: .destructive) { Task { await remove(rule) } } label: { Label("Delete", systemImage: "trash") }
                        }
                    }
                }
            } footer: {
                Text("A message or an attached file that breaks a rule is stopped, or the sender is asked first. What matched is never kept.")
            }
            if canEdit {
                Section { Button { adding = true } label: { Label("Add a rule", systemImage: "plus") } }
            }
        }
        .navigationTitle("Data rules").navigationBarTitleDisplayMode(.inline)
        .modifier(AdminLoad(error: error, loaded: loaded, reload: load))
        .sheet(isPresented: $adding) {
            NewDataRuleSheet(detectors: detectors) { await load() }
        }
    }

    private func load() async {
        guard let ctx = AdminService.context else { return }
        do {
            let answer = try await AdminService.dataRules(orgId: ctx.orgId, base: ctx.base)
            rules = answer.rules; detectors = answer.detectors; canEdit = answer.canEdit; error = nil
        } catch { self.error = error.localizedDescription }
        loaded = true
    }

    private func change(_ rule: AdminService.DataRule, enabled: Bool) async {
        guard let ctx = AdminService.context else { return }
        do { try await AdminService.setRule(rule.id, enabled: enabled, orgId: ctx.orgId, base: ctx.base); Haptics.success() }
        catch { self.error = error.localizedDescription }
        await load()
    }

    private func remove(_ rule: AdminService.DataRule) async {
        guard let ctx = AdminService.context else { return }
        do { try await AdminService.deleteRule(rule.id, orgId: ctx.orgId, base: ctx.base) }
        catch { self.error = error.localizedDescription }
        await load()
    }
}

private struct DataRuleRow: View {
    let rule: AdminService.DataRule
    let canEdit: Bool
    let toggle: (Bool) -> Void

    var body: some View {
        Toggle(isOn: Binding(get: { rule.enabled }, set: toggle)) {
            VStack(alignment: .leading, spacing: 2) {
                Text(rule.name).font(.body.weight(.semibold))
                Text(detail).font(.caption).foregroundStyle(Theme.Colors.textSecondary).lineLimit(2)
            }
        }
        .disabled(!canEdit)
    }

    private var detail: String {
        let what: String
        switch rule.kind {
        case "keywords": what = (rule.keywords ?? []).joined(separator: ", ")
        case "regex": what = String(localized: "Pattern")
        default: what = String(localized: "Built in")
        }
        let action = rule.action == "block" ? String(localized: "Blocks") : String(localized: "Warns")
        return "\(action) · \(what)"
    }
}

private struct NewDataRuleSheet: View {
    let detectors: [AdminService.Detector]
    let saved: () async -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var detector = ""
    @State private var name = ""
    @State private var words = ""
    @State private var block = false
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Picker("What it looks for", selection: $detector) {
                    Text("Words you list").tag("")
                    ForEach(detectors) { Text($0.name).tag($0.id) }
                }
                if detector.isEmpty {
                    TextField("Rule name", text: $name)
                    TextField("Words, one per line or separated by commas", text: $words, axis: .vertical).lineLimit(3...6)
                }
                Toggle("Block (instead of asking first)", isOn: $block)
                if let error { Text(error).foregroundStyle(Theme.Colors.reject) }
            }
            .navigationTitle("New data rule").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button("Save") { Task { await save() } }.disabled(busy || !ready) }
            }
        }
    }

    private var ready: Bool {
        !detector.isEmpty || (!name.trimmingCharacters(in: .whitespaces).isEmpty && !words.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
    }

    private func save() async {
        guard let ctx = AdminService.context else { return }
        busy = true
        defer { busy = false }
        let list = words.split(whereSeparator: { $0 == "\n" || $0 == "," }).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        do {
            try await AdminService.addRule(orgId: ctx.orgId, detector: detector.isEmpty ? nil : detector, keywords: list, name: name, action: block ? "block" : "warn", base: ctx.base)
            Haptics.success()
            await saved()
            dismiss()
        } catch { self.error = error.localizedDescription }
    }
}

// MARK: - Compliance

struct ComplianceAdminView: View {
    @State private var governance: AdminService.Governance?
    @State private var holds: [AdminService.Hold] = []
    @State private var exports: [AdminService.ComplianceExport] = []
    @State private var loaded = false
    @State private var error: String?

    var body: some View {
        List {
            if let g = governance {
                Section("How long things are kept") {
                    LabeledContent("Public channels", value: AdminService.days(g.retention.publicDays))
                    LabeledContent("Private channels", value: AdminService.days(g.retention.privateDays))
                    LabeledContent("Direct messages", value: AdminService.days(g.retention.dmDays))
                    LabeledContent("Files", value: AdminService.days(g.retention.filesDays))
                }
                Section("Where it can be used from") {
                    LabeledContent("Allowed networks", value: g.network.enforce ? String(localized: "On") : String(localized: "Off"))
                    ForEach(g.network.allowlist, id: \.self) { Text($0).font(.footnote.monospaced()) }
                }
                Section("Who may be invited") {
                    LabeledContent("Invitations", value: policyName(g.invites.policy))
                    if g.invites.policy != "open" {
                        LabeledContent("Guests", value: g.invites.guestsExempt ? String(localized: "Anyone") : String(localized: "Same rule"))
                    }
                }
            }
            Section("Legal holds") {
                if loaded && holds.isEmpty { Text("No holds.").foregroundStyle(Theme.Colors.textSecondary) }
                ForEach(holds) { hold in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(hold.target.name ?? hold.target.channel ?? "").font(.body.weight(.semibold))
                        Text(hold.reason).font(.caption).foregroundStyle(Theme.Colors.textSecondary)
                        Text(hold.releasedAt == nil ? String(localized: "Holding") : String(localized: "Released"))
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(hold.releasedAt == nil ? Theme.Colors.accent : Theme.Colors.textSecondary)
                    }
                }
            }
            Section {
                if loaded && exports.isEmpty { Text("No exports.").foregroundStyle(Theme.Colors.textSecondary) }
                ForEach(exports) { e in
                    LabeledContent(ChatDates.parse(e.createdAt)?.formatted(date: .abbreviated, time: .shortened) ?? e.createdAt, value: exportStatus(e.status))
                }
            } header: { Text("Exports") } footer: {
                Text("Retention, allowed networks, invitations, holds and exports are changed and downloaded on the web, where an owner signs in again first.")
            }
        }
        .navigationTitle("Compliance").navigationBarTitleDisplayMode(.inline)
        .modifier(AdminLoad(error: error, loaded: loaded, reload: load))
    }

    private func policyName(_ policy: String) -> String {
        switch policy {
        case "company": String(localized: "Only people at the company’s domains")
        case "approval": String(localized: "Outside the company, an owner approves")
        default: String(localized: "Anyone")
        }
    }

    private func exportStatus(_ status: String) -> String {
        switch status {
        case "ready": String(localized: "Ready")
        case "failed": String(localized: "Failed")
        case "expired": String(localized: "Expired")
        default: String(localized: "Preparing")
        }
    }

    private func load() async {
        guard let ctx = AdminService.context else { return }
        do {
            governance = try await AdminService.governance(orgId: ctx.orgId, base: ctx.base)
            holds = try await AdminService.holds(orgId: ctx.orgId, base: ctx.base)
            exports = try await AdminService.exports(orgId: ctx.orgId, base: ctx.base)
            error = nil
        } catch { self.error = error.localizedDescription }
        loaded = true
    }
}

// MARK: - Single sign-on and audit streams

struct SignOnAdminView: View {
    @State private var sso: AdminService.SSO?
    @State private var streams: [AdminService.Stream] = []
    @State private var loaded = false
    @State private var error: String?

    var body: some View {
        List {
            Section {
                if let sso {
                    LabeledContent("Required", value: sso.enforce ? String(localized: "Yes") : String(localized: "No"))
                    if sso.connections.isEmpty { Text("No identity provider is connected.").foregroundStyle(Theme.Colors.textSecondary) }
                    ForEach(sso.connections) { ConnectionRow(connection: $0) }
                }
            } header: { Text("Single sign-on") } footer: {
                Text("When your identity provider signs someone out or switches them off, their session here ends too.")
            }
            Section("Audit streams") {
                if loaded && streams.isEmpty { Text("The audit log is not sent anywhere.").foregroundStyle(Theme.Colors.textSecondary) }
                ForEach(streams) { StreamRow(stream: $0) }
            }
        }
        .navigationTitle("Single sign-on").navigationBarTitleDisplayMode(.inline)
        .modifier(AdminLoad(error: error, loaded: loaded, reload: load))
    }

    private func load() async {
        guard let ctx = AdminService.context else { return }
        do {
            sso = try await AdminService.sso(orgId: ctx.orgId, base: ctx.base)
            streams = try await AdminService.streams(orgId: ctx.orgId, base: ctx.base)
            error = nil
        } catch { self.error = error.localizedDescription }
        loaded = true
    }
}

private struct ConnectionRow: View {
    let connection: AdminService.Connection

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack {
                Text(connection.name).font(.body.weight(.semibold))
                Spacer()
                Text(status).font(.caption.weight(.semibold))
                    .foregroundStyle(connection.status == "active" ? Theme.Colors.accent : Theme.Colors.textSecondary)
            }
            Text(connection.allowedDomains.joined(separator: ", ")).font(.caption).foregroundStyle(Theme.Colors.textSecondary)
        }
    }

    private var status: String {
        switch connection.status {
        case "active": String(localized: "On")
        case "disabled": String(localized: "Off")
        default: String(localized: "Not on yet")
        }
    }
}

private struct StreamRow: View {
    let stream: AdminService.Stream

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack {
                Text(kind).font(.body.weight(.semibold))
                Spacer()
                Text(stream.status == "active" ? String(localized: "Sending") : stream.status == "paused" ? String(localized: "Paused") : String(localized: "Stopped"))
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(stream.status == "active" ? Theme.Colors.accent : Theme.Colors.reject)
            }
            if let at = ChatDates.parse(stream.lastSentAt) {
                Text("Last sent \(at.formatted(.relative(presentation: .named)))").font(.caption).foregroundStyle(Theme.Colors.textSecondary)
            }
            if let lastError = stream.lastError, !lastError.isEmpty {
                Text(lastError).font(.caption).foregroundStyle(Theme.Colors.reject).lineLimit(2)
            }
        }
    }

    private var kind: String {
        switch stream.kind {
        case "splunk_hec": "Splunk"
        case "datadog": "Datadog"
        case "https": String(localized: "Webhook")
        default: stream.kind
        }
    }
}
