import SwiftUI

// The harness on the phone (docs/kylon-gap-plan.md): the hub that switches
// a workspace between Simple and Harness, and — in a harness workspace —
// Apps, Workflows, Approvals, the agent team and Skills. A simple workspace
// reaches only the hub, so the feed and the chat stay what they were.

/// The workspace and the Worker every harness screen talks to.
struct HarnessWhere {
    let orgId: String
    let base: URL

    @MainActor
    init?(_ app: AppState) {
        guard !app.isGuest, let base = app.backendBaseURL, let orgId = app.currentUser?.teamID, !orgId.isEmpty else { return nil }
        self.orgId = orgId
        self.base = base
    }
}

/// Signed out, or the demo: the harness is a real workspace's.
struct HarnessUnavailable: View {
    var body: some View {
        ContentUnavailableView(String(localized: "Sign in to use the harness."), systemImage: "bolt.slash")
    }
}

/// An error line, the way the other settings screens say one.
struct HarnessError: View {
    let message: String?
    var body: some View {
        if let message {
            Text(message).font(Theme.TypeScale.caption).foregroundStyle(Theme.Colors.reject)
        }
    }
}

// MARK: - Hub

struct HarnessHubView: View {
    @EnvironmentObject private var appState: AppState
    @State private var mode: HarnessService.Mode = HarnessService.cachedMode
    @State private var canEdit = false
    @State private var busy = false
    @State private var message: String?

    var body: some View {
        Form {
            Section {
                Text(String(localized: "One workspace where your team and AI agents run the business together. Simple mode keeps Honmaru as it is: the decision feed and the chat."))
                    .font(Theme.TypeScale.caption)
                    .foregroundStyle(Theme.Colors.textSecondary)
                Picker(String(localized: "Workspace mode"), selection: Binding(get: { mode }, set: { change(to: $0) })) {
                    Text(String(localized: "Simple")).tag(HarnessService.Mode.simple)
                    Text(String(localized: "Harness")).tag(HarnessService.Mode.harness)
                }
                .pickerStyle(.segmented)
                .disabled(!canEdit || busy)
                .accessibilityIdentifier("harness.mode")
                if !canEdit {
                    Text(String(localized: "Only an admin can change the workspace mode."))
                        .font(Theme.TypeScale.caption).foregroundStyle(Theme.Colors.textTertiary)
                }
                HarnessError(message: message)
            }
            if mode == .harness {
                Section {
                    NavigationLink { HarnessAppsView().environmentObject(appState) } label: {
                        Label(String(localized: "Apps"), systemImage: "square.grid.2x2")
                    }.accessibilityIdentifier("harness.apps")
                    NavigationLink { HarnessWorkflowsView().environmentObject(appState) } label: {
                        Label(String(localized: "Workflows"), systemImage: "bolt")
                    }
                    NavigationLink { HarnessApprovalsView().environmentObject(appState) } label: {
                        Label(String(localized: "Approvals"), systemImage: "checkmark.circle")
                    }
                    NavigationLink { HarnessAgentsView().environmentObject(appState) } label: {
                        Label(String(localized: "Agent team"), systemImage: "sparkles")
                    }
                    NavigationLink { HarnessSkillsView().environmentObject(appState) } label: {
                        Label(String(localized: "Skills"), systemImage: "book")
                    }
                }
            }
        }
        .navigationTitle(String(localized: "Harness"))
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
    }

    private func load() async {
        guard let at = HarnessWhere(appState) else { return }
        do {
            let state = try await HarnessService.mode(orgId: at.orgId, base: at.base)
            mode = state.mode
            canEdit = state.canEdit
            HarnessService.cachedMode = state.mode
        } catch {
            message = error.localizedDescription
        }
    }

    private func change(to next: HarnessService.Mode) {
        guard next != mode, let at = HarnessWhere(appState) else { return }
        busy = true
        message = nil
        Task {
            defer { busy = false }
            do {
                let state = try await HarnessService.setMode(next, orgId: at.orgId, base: at.base)
                mode = state.mode
                HarnessService.cachedMode = state.mode
            } catch {
                message = error.localizedDescription
            }
        }
    }
}

extension HarnessService {
    /// The last mode this phone saw, so the You screen can show the harness's
    /// rows without waiting on the network.
    static var cachedMode: Mode {
        get { Mode(rawValue: UserDefaults.standard.string(forKey: "harness.mode.\(SessionStore.orgId ?? "")") ?? "") ?? .simple }
        set { UserDefaults.standard.set(newValue.rawValue, forKey: "harness.mode.\(SessionStore.orgId ?? "")") }
    }
}

// MARK: - Apps

struct HarnessAppsView: View {
    @EnvironmentObject private var appState: AppState
    @State private var apps: [HarnessService.App]?
    @State private var templates: [HarnessService.Template] = []
    @State private var prompt = ""
    @State private var busy = false
    @State private var message: String?
    @State private var opened: String?

    var body: some View {
        if let at = HarnessWhere(appState) {
            Form {
                Section {
                    TextField(String(localized: "e.g. An invoice tracker for #ops, from the billing inbox"), text: $prompt, axis: .vertical)
                        .lineLimit(2...4)
                        .accessibilityIdentifier("harness.describe")
                    Button(busy ? String(localized: "Building…") : String(localized: "Build")) { build(at) }
                        .disabled(busy || prompt.trimmingCharacters(in: .whitespaces).isEmpty)
                } header: { Text(String(localized: "Describe an app")) } footer: { Text(String(localized: "Your AI designs the table and its views.")) }
                HarnessError(message: message)
                Section(String(localized: "Your apps")) {
                    if apps == nil { ProgressView() }
                    if apps?.isEmpty == true {
                        Text(String(localized: "No apps yet. Describe one above, or start from a template.")).foregroundStyle(Theme.Colors.textSecondary)
                    }
                    ForEach(apps ?? []) { app in
                        NavigationLink {
                            HarnessAppDetailView(appId: app.id).environmentObject(appState)
                        } label: {
                            appRow(icon: app.icon, name: app.name, sub: app.description, rooms: app.channels ?? [])
                        }
                    }
                }
                Section(String(localized: "Templates")) {
                    ForEach(templates) { t in
                        Button { start(t.id, at) } label: { appRow(icon: t.icon, name: Bundle.main.localizedString(forKey: t.name, value: t.name, table: nil), sub: Bundle.main.localizedString(forKey: t.description, value: t.description, table: nil), rooms: []) }
                            .buttonStyle(.plain)
                            .disabled(busy)
                    }
                }
            }
            .navigationTitle(String(localized: "Apps"))
            .navigationBarTitleDisplayMode(.inline)
            // An app just built or started from a template opens at once.
            .navigationDestination(item: $opened) { id in HarnessAppDetailView(appId: id).environmentObject(appState) }
            .task { await load(at) }
            .refreshable { await load(at) }
        } else {
            HarnessUnavailable()
        }
    }

    private func appRow(icon: String, name: String, sub: String, rooms: [String]) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Text(icon).font(.title2)
            VStack(alignment: .leading, spacing: 2) {
                Text(name).font(.subheadline.weight(.semibold))
                if !sub.isEmpty { Text(sub).font(Theme.TypeScale.caption).foregroundStyle(Theme.Colors.textSecondary) }
                if !rooms.isEmpty {
                    Text(rooms.map { $0.replacingOccurrences(of: "b:", with: "#") }.joined(separator: " "))
                        .font(Theme.TypeScale.label).foregroundStyle(Theme.Colors.accent)
                }
            }
        }
    }

    private func load(_ at: HarnessWhere) async {
        do {
            async let a = HarnessService.apps(orgId: at.orgId, base: at.base)
            async let t = HarnessService.templates(orgId: at.orgId, base: at.base)
            let (listed, offered) = try await (a, t)
            apps = listed
            templates = offered
        } catch {
            apps = apps ?? []
            message = error.localizedDescription
        }
    }

    private func build(_ at: HarnessWhere) {
        busy = true; message = nil
        Task {
            defer { busy = false }
            do {
                let made = try await HarnessService.generate(prompt, orgId: at.orgId, base: at.base)
                prompt = ""
                message = made.fromModel ? String(localized: "Built from your description.") : String(localized: "Started from the closest template. Change its columns any time.")
                await load(at)
                opened = made.app.id
            } catch {
                message = error.localizedDescription
            }
        }
    }

    private func start(_ template: String, _ at: HarnessWhere) {
        busy = true; message = nil
        Task {
            defer { busy = false }
            do {
                let app = try await HarnessService.fromTemplate(template, orgId: at.orgId, base: at.base)
                await load(at)
                opened = app.id
            } catch {
                message = error.localizedDescription
            }
        }
    }
}

struct HarnessAppDetailView: View {
    let appId: String
    @EnvironmentObject private var appState: AppState
    @Environment(\.dismiss) private var dismiss
    @State private var data: HarnessService.RenderedApp?
    @State private var paneIndex = 0
    @State private var editing: EditTarget?
    @State private var versions: [HarnessService.Version]?
    @State private var room = ""
    @State private var confirmDelete = false
    @State private var message: String?

    /// A row to change, or a new one to add.
    struct EditTarget: Identifiable {
        let row: HarnessService.Row?
        var id: String { row?.id ?? "new" }
    }

    var body: some View {
        if let at = HarnessWhere(appState) {
            content(at)
                .navigationTitle(data.map { "\($0.app.icon) \($0.app.name)" } ?? String(localized: "Apps"))
                .navigationBarTitleDisplayMode(.inline)
                .task { await load(at) }
                .refreshable { await load(at) }
                .sheet(item: $editing) { target in
                    if let data {
                        HarnessRowEditor(table: data.table, row: target.row) { values in
                            if let row = target.row {
                                try await HarnessService.updateRow(table: data.table.id, row: row.id, values: values, orgId: at.orgId, base: at.base)
                            } else {
                                try await HarnessService.addRow(table: data.table.id, values: values, orgId: at.orgId, base: at.base)
                            }
                            await load(at)
                        } onDelete: { row in
                            try await HarnessService.deleteRow(table: data.table.id, row: row.id, orgId: at.orgId, base: at.base)
                            await load(at)
                        }
                    }
                }
                .confirmationDialog(String(localized: "Delete this app and all its rows?"), isPresented: $confirmDelete, titleVisibility: .visible) {
                    Button(String(localized: "Delete app"), role: .destructive) {
                        Task {
                            do { try await HarnessService.deleteApp(appId, orgId: at.orgId, base: at.base); dismiss() }
                            catch { message = error.localizedDescription }
                        }
                    }
                }
        } else {
            HarnessUnavailable()
        }
    }

    @ViewBuilder
    private func content(_ at: HarnessWhere) -> some View {
        if let data {
            let panes = data.views
            let pane = panes.isEmpty ? nil : panes[min(paneIndex, panes.count - 1)]
            ScrollView {
                VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                    if !data.app.description.isEmpty {
                        Text(data.app.description).font(Theme.TypeScale.caption).foregroundStyle(Theme.Colors.textSecondary)
                    }
                    Picker(String(localized: "View"), selection: $paneIndex) {
                        ForEach(Array(panes.enumerated()), id: \.offset) { i, p in Text(p.name).tag(i) }
                    }
                    .pickerStyle(.segmented)
                    HarnessError(message: message)
                    if let pane {
                        switch pane.type {
                        case "metrics": metrics(pane)
                        case "board": board(pane, table: data.table)
                        default: rows(pane.rows ?? [], table: data.table)
                        }
                    }
                    if pane?.type != "metrics" {
                        Button { editing = EditTarget(row: nil) } label: { Label(String(localized: "Add a row"), systemImage: "plus") }
                            .buttonStyle(.bordered)
                    }
                    rooms(data.app, at)
                    versionList(data.app, at, canRestore: data.canCustomize != false)
                    Button(String(localized: "Delete app"), role: .destructive) { confirmDelete = true }
                        .padding(.top, Theme.Spacing.sm)
                }
                .padding(Theme.Spacing.md)
            }
            .appBackground()
        } else if let message {
            Text(message).padding()
        } else {
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private func metrics(_ pane: HarnessService.Pane) -> some View {
        LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 10) {
            ForEach(pane.values ?? []) { m in
                VStack(alignment: .leading, spacing: 4) {
                    Text(HarnessService.metricText(m)).font(.title.weight(.bold)).monospacedDigit()
                    Text(m.label).font(Theme.TypeScale.caption).foregroundStyle(Theme.Colors.textSecondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(14)
                .background(Theme.Colors.surface, in: RoundedRectangle(cornerRadius: Theme.Radius.card))
            }
        }
    }

    private func board(_ pane: HarnessService.Pane, table: HarnessService.Table) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(alignment: .top, spacing: 10) {
                ForEach(pane.lanes ?? []) { lane in
                    VStack(alignment: .leading, spacing: 8) {
                        HStack {
                            Text(lane.key ?? String(localized: "No value")).font(.subheadline.weight(.semibold))
                            Spacer()
                            Text("\(lane.rows.count)").font(Theme.TypeScale.caption).foregroundStyle(Theme.Colors.textTertiary)
                        }
                        ForEach(lane.rows) { row in
                            Button { editing = EditTarget(row: row) } label: { card(row, table: table, skip: pane.groupBy) }
                                .buttonStyle(.plain)
                        }
                    }
                    .frame(width: 200, alignment: .topLeading)
                    .padding(8)
                    .background(Theme.Colors.surface, in: RoundedRectangle(cornerRadius: Theme.Radius.card))
                }
            }
        }
    }

    private func card(_ row: HarnessService.Row, table: HarnessService.Table, skip: String?) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            if let first = table.columns.first {
                Text(HarnessService.cellText(first, row.values[first.id]).isEmpty ? "—" : HarnessService.cellText(first, row.values[first.id]))
                    .font(.subheadline.weight(.semibold))
            }
            ForEach(table.columns.dropFirst().filter { $0.id != skip && !HarnessService.cellText($0, row.values[$0.id]).isEmpty }.prefix(3)) { c in
                Text("\(c.name) \(HarnessService.cellText(c, row.values[c.id]))").font(Theme.TypeScale.label).foregroundStyle(Theme.Colors.textSecondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(8)
        .background(Theme.Colors.background, in: RoundedRectangle(cornerRadius: Theme.Radius.input))
    }

    private func rows(_ rows: [HarnessService.Row], table: HarnessService.Table) -> some View {
        VStack(spacing: 0) {
            if rows.isEmpty {
                Text(String(localized: "Nothing here yet.")).font(Theme.TypeScale.caption).foregroundStyle(Theme.Colors.textTertiary).padding()
            }
            ForEach(rows) { row in
                Button { editing = EditTarget(row: row) } label: {
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            if let first = table.columns.first {
                                Text(HarnessService.cellText(first, row.values[first.id]).isEmpty ? "—" : HarnessService.cellText(first, row.values[first.id])).font(.subheadline)
                            }
                            Text(table.columns.dropFirst().map { HarnessService.cellText($0, row.values[$0.id]) }.filter { !$0.isEmpty }.joined(separator: " · "))
                                .font(Theme.TypeScale.label).foregroundStyle(Theme.Colors.textSecondary).lineLimit(1)
                        }
                        Spacer()
                        Image(systemName: "chevron.right").font(.caption).foregroundStyle(Theme.Colors.textTertiary)
                    }
                    .padding(12)
                }
                .buttonStyle(.plain)
                Divider()
            }
        }
        .background(Theme.Colors.surface, in: RoundedRectangle(cornerRadius: Theme.Radius.card))
    }

    private func rooms(_ app: HarnessService.App, _ at: HarnessWhere) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(String(localized: "Rooms")).font(Theme.TypeScale.label).foregroundStyle(Theme.Colors.textTertiary)
            if let channels = app.channels, !channels.isEmpty {
                Text(channels.map { $0.replacingOccurrences(of: "b:", with: "#") }.joined(separator: " ")).font(.subheadline).foregroundStyle(Theme.Colors.accent)
            } else {
                Text(String(localized: "Link it to a room and it shows there, next to the conversation.")).font(Theme.TypeScale.caption).foregroundStyle(Theme.Colors.textSecondary)
            }
            HStack {
                TextField("#ops", text: $room).textInputAutocapitalization(.never).textFieldStyle(.roundedBorder)
                Button(String(localized: "Link")) {
                    let key = "b:" + room.replacingOccurrences(of: "#", with: "").trimmingCharacters(in: .whitespaces)
                    Task {
                        do { try await HarnessService.link(app.id, channel: key, orgId: at.orgId, base: at.base); room = ""; await load(at) }
                        catch { message = error.localizedDescription }
                    }
                }
                .disabled(room.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
    }

    private func versionList(_ app: HarnessService.App, _ at: HarnessWhere, canRestore: Bool) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(String(localized: "Versions")).font(Theme.TypeScale.label).foregroundStyle(Theme.Colors.textTertiary)
            if let versions {
                ForEach(versions) { v in
                    HStack {
                        Text("v\(v.version)\(v.note.map { " · \($0)" } ?? "")").font(.subheadline)
                        Spacer()
                        if canRestore && v.version != app.version {
                            Button(String(localized: "Restore")) {
                                Task {
                                    do { try await HarnessService.restore(app.id, version: v.version, orgId: at.orgId, base: at.base); self.versions = nil; await load(at) }
                                    catch { message = error.localizedDescription }
                                }
                            }
                        }
                    }
                }
            } else {
                Button(String(localized: "Show version history")) {
                    Task { versions = try? await HarnessService.versions(app.id, orgId: at.orgId, base: at.base) }
                }
            }
        }
    }

    private func load(_ at: HarnessWhere) async {
        do { data = try await HarnessService.app(appId, orgId: at.orgId, base: at.base) }
        catch { message = error.localizedDescription }
    }
}

/// One row, field by field, in each column's own control.
struct HarnessRowEditor: View {
    let table: HarnessService.Table
    let row: HarnessService.Row?
    let onSave: ([String: Any]) async throws -> Void
    let onDelete: (HarnessService.Row) async throws -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var texts: [String: String] = [:]
    @State private var flags: [String: Bool] = [:]
    @State private var busy = false
    @State private var message: String?

    var body: some View {
        NavigationStack {
            Form {
                ForEach(table.columns) { c in field(c) }
                HarnessError(message: message)
                if let row {
                    Button(String(localized: "Delete row"), role: .destructive) {
                        Task {
                            do { try await onDelete(row); dismiss() } catch { message = error.localizedDescription }
                        }
                    }
                }
            }
            .navigationTitle(row == nil ? String(localized: "Add a row") : String(localized: "Edit"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(String(localized: "Cancel")) { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button(String(localized: "Save")) { save() }.disabled(busy) }
            }
            .onAppear(perform: fill)
        }
    }

    @ViewBuilder
    private func field(_ c: HarnessService.Column) -> some View {
        switch c.type {
        case "checkbox":
            Toggle(c.name, isOn: Binding(get: { flags[c.id] ?? false }, set: { flags[c.id] = $0 }))
        case "select":
            Picker(c.name, selection: Binding(get: { texts[c.id] ?? "" }, set: { texts[c.id] = $0 })) {
                Text("—").tag("")
                ForEach(c.options ?? [], id: \.self) { Text($0).tag($0) }
            }
        default:
            TextField(c.name, text: Binding(get: { texts[c.id] ?? "" }, set: { texts[c.id] = $0 }))
                .keyboardType(c.type == "number" ? .decimalPad : c.type == "email" ? .emailAddress : c.type == "url" ? .URL : .default)
                .textInputAutocapitalization(["email", "url", "person"].contains(c.type) ? TextInputAutocapitalization.never : TextInputAutocapitalization.sentences)
        }
    }

    private func fill() {
        guard let row else { return }
        for c in table.columns {
            let v = row.values[c.id]
            if c.type == "checkbox", case .bool(let on) = v { flags[c.id] = on }
            else { texts[c.id] = v?.text ?? "" }
        }
    }

    private func save() {
        var values: [String: Any] = [:]
        for c in table.columns {
            if c.type == "checkbox" { values[c.id] = flags[c.id] ?? false }
            else if let text = texts[c.id] { values[c.id] = HarnessService.value(for: c, from: text) }
        }
        busy = true
        Task {
            defer { busy = false }
            do { try await onSave(values); dismiss() } catch { message = error.localizedDescription }
        }
    }
}

// MARK: - Approvals

struct HarnessApprovalsView: View {
    @EnvironmentObject private var appState: AppState
    @State private var data: HarnessService.Approvals?
    @State private var message: String?

    var body: some View {
        if let at = HarnessWhere(appState) {
            List {
                Section {
                    Text(String(localized: "Agents propose, people approve. Everything an agent or a workflow is waiting on you for, in one place."))
                        .font(Theme.TypeScale.caption).foregroundStyle(Theme.Colors.textSecondary)
                    HarnessError(message: message)
                }
                Section {
                    if data == nil { ProgressView() }
                    if data?.toDecide.isEmpty == true { Text(String(localized: "Nothing is waiting on you.")).foregroundStyle(Theme.Colors.textSecondary) }
                    ForEach(data?.toDecide ?? []) { a in
                        Label {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(a.title).font(.subheadline)
                                Text([a.source, a.summary].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "))
                                    .font(Theme.TypeScale.caption).foregroundStyle(Theme.Colors.textSecondary)
                            }
                        } icon: { Image(systemName: a.kind == "workflow" ? "bolt" : "sparkles") }
                    }
                } header: {
                    Text(String(localized: "Waiting on you"))
                } footer: {
                    Text(String(localized: "Decide them in your feed, like any other card."))
                }
                Section(String(localized: "Waiting on others")) {
                    if data?.waitingOnOthers.isEmpty == true { Text(String(localized: "No workflow of yours is waiting on anyone.")).foregroundStyle(Theme.Colors.textSecondary) }
                    ForEach(data?.waitingOnOthers ?? []) { w in
                        Label(w.workflow, systemImage: "clock")
                    }
                }
            }
            .navigationTitle(String(localized: "Approvals"))
            .navigationBarTitleDisplayMode(.inline)
            .task { await load(at) }
            .refreshable { await load(at) }
        } else {
            HarnessUnavailable()
        }
    }

    private func load(_ at: HarnessWhere) async {
        do { data = try await HarnessService.approvals(orgId: at.orgId, base: at.base) }
        catch { message = error.localizedDescription; data = data ?? HarnessService.Approvals(toDecide: [], waitingOnOthers: []) }
    }
}
