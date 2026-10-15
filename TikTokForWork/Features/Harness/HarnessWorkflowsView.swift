import SwiftUI

// Workflows on the phone (docs/kylon-gap-plan.md): the list, one workflow's
// runs and every step's outcome, and a form to make one — a trigger and the
// steps after it. Approvals a run waits on arrive in the feed as cards.

private func stepLabel(_ type: String) -> String {
    switch type {
    case "post": String(localized: "Post in a room")
    case "agent": String(localized: "Ask an agent")
    case "add_row": String(localized: "Add a row")
    case "update_row": String(localized: "Change the row")
    case "approval": String(localized: "Ask for approval")
    case "followup": String(localized: "Follow up later")
    default: type
    }
}

private func statusLabel(_ status: String) -> String {
    switch status {
    case "done": String(localized: "done")
    case "ok": String(localized: "ok")
    case "failed": String(localized: "failed")
    case "waiting": String(localized: "waiting")
    case "running": String(localized: "running")
    case "declined": String(localized: "declined")
    default: status
    }
}

private func statusColor(_ status: String) -> Color {
    switch status {
    case "done", "ok": Theme.Colors.approve
    case "failed", "declined": Theme.Colors.reject
    default: Theme.Colors.accent
    }
}

/// One step of a run, as a line: what it was, how it went, what it said.
private func logLine(_ l: HarnessService.RunLog) -> String {
    let said = l.output ?? l.error ?? ""
    let tail = said.isEmpty ? "" : ": " + String(said.prefix(140))
    return "\(l.step). " + stepLabel(l.type) + " — " + statusLabel(l.status) + tail
}

private func triggerLabel(_ t: HarnessService.Trigger, tables: [HarnessService.Table]) -> String {
    switch t.type {
    case "schedule": return String(localized: "Schedule") + ": \(t.cadence ?? "") \(String(format: "%02d:%02d", t.hour ?? 9, t.minute ?? 0))"
    case "row":
        let name = tables.first { $0.id == t.tableId }?.name ?? "?"
        return String(localized: "When a row changes in \(name)")
    case "webhook": return String(localized: "When its webhook is called")
    default: return String(localized: "When someone runs it")
    }
}

struct HarnessWorkflowsView: View {
    @EnvironmentObject private var appState: AppState
    @State private var workflows: [HarnessService.Workflow]?
    @State private var tables: [HarnessService.Table] = []
    @State private var agents: [HarnessService.Agent] = []
    @State private var building = false
    @State private var hook: String?
    @State private var message: String?

    var body: some View {
        if let at = HarnessWhere(appState) {
            List {
                Section {
                    Text(String(localized: "Describe the outcome once: when it should happen, and what follows. A person approves what matters."))
                        .font(Theme.TypeScale.caption).foregroundStyle(Theme.Colors.textSecondary)
                    HarnessError(message: message)
                    if let hook {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(String(localized: "Call this address to start it:")).font(Theme.TypeScale.caption)
                            Text(hook).font(.caption.monospaced()).textSelection(.enabled)
                        }
                    }
                }
                Section {
                    if workflows == nil { ProgressView() }
                    if workflows?.isEmpty == true { Text(String(localized: "No workflows yet.")).foregroundStyle(Theme.Colors.textSecondary) }
                    ForEach(workflows ?? []) { w in
                        NavigationLink { HarnessWorkflowDetailView(workflowId: w.id, tables: tables).environmentObject(appState) } label: {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(w.name + (w.enabled ? "" : " · " + String(localized: "off"))).font(.subheadline)
                                Text(triggerLabel(w.trigger, tables: tables) + " · " + w.steps.map { stepLabel($0.type) }.joined(separator: " → "))
                                    .font(Theme.TypeScale.caption).foregroundStyle(Theme.Colors.textSecondary)
                            }
                        }
                    }
                }
            }
            .navigationTitle(String(localized: "Workflows"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button { building = true } label: { Image(systemName: "plus") }.accessibilityLabel(String(localized: "New"))
                }
            }
            .sheet(isPresented: $building) {
                HarnessWorkflowBuilder(tables: tables, agents: agents) { name, trigger, steps in
                    hook = try await HarnessService.createWorkflow(name: name, trigger: trigger, steps: steps, orgId: at.orgId, base: at.base)
                    await load(at)
                }
            }
            .task { await load(at) }
            .refreshable { await load(at) }
        } else {
            HarnessUnavailable()
        }
    }

    private func load(_ at: HarnessWhere) async {
        do {
            async let w = HarnessService.workflows(orgId: at.orgId, base: at.base)
            async let t = HarnessService.tables(orgId: at.orgId, base: at.base)
            let (listed, known) = try await (w, t)
            workflows = listed
            tables = known
            agents = (try? await HarnessService.agents(orgId: at.orgId, base: at.base)) ?? []
        } catch {
            workflows = workflows ?? []
            message = error.localizedDescription
        }
    }
}

struct HarnessWorkflowDetailView: View {
    let workflowId: String
    let tables: [HarnessService.Table]
    @EnvironmentObject private var appState: AppState
    @Environment(\.dismiss) private var dismiss
    @State private var detail: HarnessService.WorkflowDetail?
    @State private var busy = false
    @State private var message: String?

    var body: some View {
        if let at = HarnessWhere(appState) {
            List {
                if let d = detail {
                    Section {
                        Text(triggerLabel(d.workflow.trigger, tables: tables)).font(.subheadline)
                        Text(d.workflow.steps.map { stepLabel($0.type) }.joined(separator: " → "))
                            .font(Theme.TypeScale.caption).foregroundStyle(Theme.Colors.textSecondary)
                        if let next = d.workflow.nextRunAt.flatMap(HarnessService.date) {
                            Text(String(localized: "Next run \(next.formatted(date: .abbreviated, time: .shortened))"))
                                .font(Theme.TypeScale.caption).foregroundStyle(Theme.Colors.textSecondary)
                        }
                        if let url = d.workflow.hookUrl {
                            Text(url).font(.caption.monospaced()).textSelection(.enabled)
                        }
                        HarnessError(message: message)
                    }
                    if d.canEdit {
                        Section {
                            Button { act(at) { try await HarnessService.runWorkflow(workflowId, orgId: at.orgId, base: at.base) } } label: {
                                Label(String(localized: "Run now"), systemImage: "bolt")
                            }
                            .disabled(busy || !d.workflow.enabled)
                            Button(d.workflow.enabled ? String(localized: "Turn off") : String(localized: "Turn on")) {
                                act(at) { try await HarnessService.setWorkflowEnabled(workflowId, !d.workflow.enabled, orgId: at.orgId, base: at.base) }
                            }
                            Button(String(localized: "Delete"), role: .destructive) {
                                act(at) { try await HarnessService.deleteWorkflow(workflowId, orgId: at.orgId, base: at.base); dismiss() }
                            }
                        }
                    }
                    Section(String(localized: "Runs")) {
                        if d.runs.isEmpty { Text(String(localized: "It has not run yet.")).foregroundStyle(Theme.Colors.textSecondary) }
                        ForEach(d.runs) { run in
                            VStack(alignment: .leading, spacing: 4) {
                                HStack {
                                    Text(statusLabel(run.status)).font(.subheadline.weight(.semibold)).foregroundStyle(statusColor(run.status))
                                    if let started = HarnessService.date(run.startedAt) {
                                        Text(started.formatted(date: .abbreviated, time: .shortened)).font(Theme.TypeScale.caption).foregroundStyle(Theme.Colors.textSecondary)
                                    }
                                }
                                ForEach(run.log) { l in
                                    Text(verbatim: logLine(l))
                                        .font(Theme.TypeScale.label).foregroundStyle(Theme.Colors.textSecondary)
                                }
                            }
                        }
                    }
                } else if let message {
                    Text(message)
                } else {
                    ProgressView()
                }
            }
            .navigationTitle(detail?.workflow.name ?? String(localized: "Workflows"))
            .navigationBarTitleDisplayMode(.inline)
            .task { await load(at) }
            .refreshable { await load(at) }
        } else {
            HarnessUnavailable()
        }
    }

    private func load(_ at: HarnessWhere) async {
        do { detail = try await HarnessService.workflow(workflowId, orgId: at.orgId, base: at.base) }
        catch { message = error.localizedDescription }
    }

    private func act(_ at: HarnessWhere, _ work: @escaping () async throws -> Void) {
        busy = true; message = nil
        Task {
            defer { busy = false }
            do { try await work(); await load(at) } catch { message = error.localizedDescription }
        }
    }
}

/// A workflow from a form: its name, what starts it, and its steps.
struct HarnessWorkflowBuilder: View {
    let tables: [HarnessService.Table]
    let agents: [HarnessService.Agent]
    let onSave: (String, HarnessService.Trigger, [HarnessService.Step]) async throws -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var trigger = HarnessService.Trigger(type: "manual")
    @State private var time = Calendar.current.date(bySettingHour: 9, minute: 0, second: 0, of: Date()) ?? Date()
    @State private var steps: [HarnessService.Step] = [HarnessService.Step(type: "post")]
    @State private var busy = false
    @State private var message: String?

    private let cadences = ["daily", "weekdays", "weekly", "monthly"]
    private let stepTypes = ["post", "agent", "approval", "followup", "add_row"]

    var body: some View {
        NavigationStack {
            Form {
                Section { TextField(String(localized: "Workflow name"), text: $name) }
                Section(String(localized: "Trigger")) {
                    Picker(String(localized: "Trigger"), selection: $trigger.type) {
                        Text(String(localized: "By hand")).tag("manual")
                        Text(String(localized: "On a schedule")).tag("schedule")
                        Text(String(localized: "A webhook")).tag("webhook")
                        if !tables.isEmpty { Text(String(localized: "A row added or changed")).tag("row") }
                    }
                    if trigger.type == "schedule" {
                        Picker(String(localized: "Cadence"), selection: Binding(get: { trigger.cadence ?? "weekdays" }, set: { trigger.cadence = $0 })) {
                            ForEach(cadences, id: \.self) { c in Text(Bundle.main.localizedString(forKey: c, value: c, table: nil)).tag(c) }
                        }
                        DatePicker(String(localized: "Time"), selection: $time, displayedComponents: .hourAndMinute)
                    }
                    if trigger.type == "row" {
                        Picker(String(localized: "Table"), selection: Binding(get: { trigger.tableId ?? tables.first?.id ?? "" }, set: { trigger.tableId = $0 })) {
                            ForEach(tables) { t in Text(t.name).tag(t.id) }
                        }
                        Picker(String(localized: "When"), selection: Binding(get: { trigger.on ?? "any" }, set: { trigger.on = $0 })) {
                            Text(String(localized: "is added")).tag("added")
                            Text(String(localized: "is changed")).tag("changed")
                            Text(String(localized: "is added or changed")).tag("any")
                        }
                    }
                }
                ForEach($steps) { $step in
                    Section {
                        Picker(String(localized: "Step"), selection: $step.type) {
                            ForEach(stepTypes, id: \.self) { Text(stepLabel($0)).tag($0) }
                        }
                        stepFields($step)
                        Button(String(localized: "Remove step"), role: .destructive) { steps.removeAll { $0.id == step.id } }
                    }
                }
                Section {
                    Button { steps.append(HarnessService.Step(type: "post")) } label: { Label(String(localized: "Add a step"), systemImage: "plus") }
                } footer: {
                    Text(String(localized: "Steps can use what started them: {{row.Column}}, {{input.text}}, {{steps.1.output}}."))
                }
                HarnessError(message: message)
            }
            .navigationTitle(String(localized: "New workflow"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(String(localized: "Cancel")) { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(String(localized: "Save")) { save() }
                        .disabled(busy || name.trimmingCharacters(in: .whitespaces).isEmpty || steps.isEmpty)
                }
            }
        }
    }

    @ViewBuilder
    private func stepFields(_ step: Binding<HarnessService.Step>) -> some View {
        let text = { (key: WritableKeyPath<HarnessService.Step, String?>) in
            Binding<String>(get: { step.wrappedValue[keyPath: key] ?? "" }, set: { step.wrappedValue[keyPath: key] = $0.isEmpty ? nil : $0 })
        }
        let room = Binding<String>(
            get: { (step.wrappedValue.channel ?? "").replacingOccurrences(of: "b:", with: "#") },
            set: { step.wrappedValue.channel = $0.isEmpty ? nil : "b:" + $0.replacingOccurrences(of: "#", with: "") }
        )
        switch step.wrappedValue.type {
        case "post":
            TextField("#ops", text: room).textInputAutocapitalization(.never)
            TextField(String(localized: "e.g. {{row.Client}} is overdue"), text: text(\.text), axis: .vertical)
        case "followup":
            TextField("#ops", text: room).textInputAutocapitalization(.never)
            TextField(String(localized: "Text"), text: text(\.text), axis: .vertical)
            Stepper(value: Binding(get: { (step.wrappedValue.minutes ?? 1440) / 60 }, set: { step.wrappedValue.minutes = max(1, $0) * 60 }), in: 1...2160) {
                Text(String(localized: "In \((step.wrappedValue.minutes ?? 1440) / 60) hours"))
            }
        case "agent":
            Picker(String(localized: "Agent"), selection: Binding(get: { step.wrappedValue.agentId ?? "" }, set: { step.wrappedValue.agentId = $0 })) {
                Text(String(localized: "Choose an agent")).tag("")
                ForEach(agents) { a in Text("\(a.emoji ?? "🤖") \(a.name)").tag(a.id) }
            }
            TextField(String(localized: "What to ask it"), text: text(\.prompt), axis: .vertical)
            TextField(String(localized: "#room to post its answer (optional)"), text: room).textInputAutocapitalization(.never)
        case "approval":
            TextField(String(localized: "@who approves"), text: Binding(get: { step.wrappedValue.to.map { "@\($0)" } ?? "" }, set: { step.wrappedValue.to = $0.replacingOccurrences(of: "@", with: "") }))
                .textInputAutocapitalization(.never)
            TextField(String(localized: "e.g. Send {{row.Client}} a reminder?"), text: text(\.title))
            TextField(String(localized: "What they should know"), text: text(\.summary), axis: .vertical)
        default:
            Text(String(localized: "Set this step up on the web.")).font(Theme.TypeScale.caption).foregroundStyle(Theme.Colors.textSecondary)
        }
    }

    private func save() {
        var t = trigger
        if t.type == "schedule" {
            let parts = Calendar.current.dateComponents([.hour, .minute], from: time)
            t.cadence = t.cadence ?? "weekdays"
            t.hour = parts.hour
            t.minute = parts.minute
            t.timezone = TimeZone.current.identifier
        }
        if t.type == "row" {
            t.tableId = t.tableId ?? tables.first?.id
            t.on = t.on ?? "any"
        }
        busy = true; message = nil
        Task {
            defer { busy = false }
            do { try await onSave(name, t, steps); dismiss() } catch { message = error.localizedDescription }
        }
    }
}
