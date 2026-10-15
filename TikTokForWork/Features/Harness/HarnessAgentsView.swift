import SwiftUI

// Agents as members, and the skills they work by (docs/kylon-gap-plan.md).
// An agent is still written under Custom agents; here it gets a specialty,
// a tier, a memory, skills, and a say in who may call it.

struct HarnessAgentsView: View {
    @EnvironmentObject private var appState: AppState
    @State private var agents: [HarnessService.Agent]?
    @State private var message: String?

    var body: some View {
        if let at = HarnessWhere(appState) {
            List {
                Section {
                    Text(String(localized: "Agents are members of the team: each with a specialty, a memory of its own, skills, and the people who may call it."))
                        .font(Theme.TypeScale.caption).foregroundStyle(Theme.Colors.textSecondary)
                    HarnessError(message: message)
                }
                Section {
                    if agents == nil { ProgressView() }
                    if agents?.isEmpty == true {
                        Text(String(localized: "No agents yet. Write one under Custom agents, then give it a role here.")).foregroundStyle(Theme.Colors.textSecondary)
                    }
                    ForEach(agents ?? []) { a in
                        NavigationLink { HarnessAgentMemberView(agent: a).environmentObject(appState) } label: {
                            HStack(spacing: 12) {
                                Text(a.emoji ?? "🤖").font(.title3)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(a.name).font(.subheadline)
                                    Text("@\(a.handle)").font(Theme.TypeScale.caption).foregroundStyle(Theme.Colors.textSecondary)
                                }
                            }
                        }
                    }
                }
            }
            .navigationTitle(String(localized: "Agent team"))
            .navigationBarTitleDisplayMode(.inline)
            .task {
                do { agents = try await HarnessService.agents(orgId: at.orgId, base: at.base) }
                catch { agents = []; message = error.localizedDescription }
            }
        } else {
            HarnessUnavailable()
        }
    }
}

struct HarnessAgentMemberView: View {
    let agent: HarnessService.Agent
    @EnvironmentObject private var appState: AppState
    @State private var profile: HarnessService.Profile?
    @State private var canEdit = false
    @State private var memories: [HarnessService.Memory] = []
    @State private var allSkills: [HarnessService.Skill] = []
    @State private var mine: Set<String> = []
    @State private var followups: [HarnessService.Followup] = []
    @State private var remember = ""
    @State private var people = ""
    @State private var message: String?

    var body: some View {
        if let at = HarnessWhere(appState) {
            Form {
                HarnessError(message: message)
                if let binding = Binding($profile) {
                    Section(String(localized: "Role")) {
                        TextField(String(localized: "e.g. Accounts receivable"), text: binding.specialty)
                            .onSubmit { save(at) }
                        Picker(String(localized: "Intelligence"), selection: binding.tier) {
                            Text(String(localized: "Lite")).tag("lite")
                            Text(String(localized: "Standard")).tag("standard")
                            Text(String(localized: "Max")).tag("max")
                        }
                        .pickerStyle(.segmented)
                        Toggle(String(localized: "Answer only when named"), isOn: binding.mentionOnly)
                        Picker(String(localized: "Who may call it"), selection: binding.access) {
                            Text(String(localized: "Everyone")).tag("everyone")
                            Text(String(localized: "Some people")).tag("people")
                            Text(String(localized: "Only its maker")).tag("private")
                        }
                        if binding.wrappedValue.access == "people" {
                            TextField("@mika @kenji", text: $people).textInputAutocapitalization(.never)
                        }
                    }
                    .disabled(!canEdit)
                    .onChange(of: binding.wrappedValue.tier) { save(at) }
                    .onChange(of: binding.wrappedValue.mentionOnly) { save(at) }
                    .onChange(of: binding.wrappedValue.access) { save(at) }
                    if canEdit {
                        Button(String(localized: "Save")) { save(at) }
                    }
                }
                Section(String(localized: "Skills")) {
                    if allSkills.isEmpty {
                        Text(String(localized: "No skills in this workspace yet. Write one on the Skills screen.")).foregroundStyle(Theme.Colors.textSecondary)
                    }
                    ForEach(allSkills) { s in
                        Toggle(isOn: Binding(get: { mine.contains(s.id) }, set: { on in setSkill(s.id, on, at) })) {
                            VStack(alignment: .leading) {
                                Text(s.name)
                                if !s.description.isEmpty { Text(s.description).font(Theme.TypeScale.caption).foregroundStyle(Theme.Colors.textSecondary) }
                            }
                        }
                        .disabled(!canEdit)
                    }
                }
                Section {
                    HStack {
                        TextField(String(localized: "e.g. Acme pays on the 25th"), text: $remember)
                        Button(String(localized: "Remember")) {
                            let text = remember
                            Task {
                                do { try await HarnessService.remember(agent: agent.id, text: text, orgId: at.orgId, base: at.base); remember = ""; await load(at) }
                                catch { message = error.localizedDescription }
                            }
                        }
                        .disabled(remember.trimmingCharacters(in: .whitespaces).isEmpty)
                    }
                    ForEach(memories) { m in
                        Text(m.text)
                            .swipeActions {
                                if canEdit {
                                    Button(String(localized: "Forget"), role: .destructive) {
                                        Task { try? await HarnessService.forget(agent: agent.id, memory: m.id, orgId: at.orgId, base: at.base); await load(at) }
                                    }
                                }
                            }
                    }
                } header: { Text(String(localized: "Memory")) } footer: {
                    Text(String(localized: "In a chat: “@\(agent.handle) remember that …”."))
                }
                Section {
                    if followups.isEmpty { Text(String(localized: "Nothing scheduled.")).foregroundStyle(Theme.Colors.textSecondary) }
                    ForEach(followups) { f in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(f.instruction)
                            Text("\(f.channel.replacingOccurrences(of: "b:", with: "#")) · \(HarnessService.date(f.dueAt)?.formatted(date: .abbreviated, time: .shortened) ?? f.dueAt)")
                                .font(Theme.TypeScale.caption).foregroundStyle(Theme.Colors.textSecondary)
                        }
                        .swipeActions {
                            Button(String(localized: "Cancel"), role: .destructive) {
                                Task { try? await HarnessService.cancelFollowup(f.id, orgId: at.orgId, base: at.base); await load(at) }
                            }
                        }
                    }
                } header: { Text(String(localized: "Follow-ups")) } footer: {
                    Text(String(localized: "In a chat: “@\(agent.handle) follow up in 3 days: …”."))
                }
            }
            .navigationTitle("\(agent.emoji ?? "🤖") \(agent.name)")
            .navigationBarTitleDisplayMode(.inline)
            .task { await load(at) }
        } else {
            HarnessUnavailable()
        }
    }

    private func load(_ at: HarnessWhere) async {
        do {
            let p = try await HarnessService.profile(agent: agent.id, orgId: at.orgId, base: at.base)
            profile = p.profile
            canEdit = p.canEdit
            people = p.profile.people.map { "@\($0)" }.joined(separator: " ")
            memories = try await HarnessService.memory(agent: agent.id, orgId: at.orgId, base: at.base)
            allSkills = try await HarnessService.skills(orgId: at.orgId, base: at.base)
            mine = Set(try await HarnessService.agentSkills(agent: agent.id, orgId: at.orgId, base: at.base).map(\.id))
            followups = try await HarnessService.followups(orgId: at.orgId, base: at.base).filter { $0.agentId == agent.id }
        } catch {
            message = error.localizedDescription
        }
    }

    private func save(_ at: HarnessWhere) {
        guard canEdit, var p = profile else { return }
        p.people = people.split(whereSeparator: { $0 == " " || $0 == "," }).map { String($0).replacingOccurrences(of: "@", with: "") }.filter { !$0.isEmpty }
        Task {
            do { try await HarnessService.saveProfile(agent: agent.id, p, orgId: at.orgId, base: at.base); message = nil }
            catch { message = error.localizedDescription }
        }
    }

    private func setSkill(_ id: String, _ on: Bool, _ at: HarnessWhere) {
        if on { mine.insert(id) } else { mine.remove(id) }
        Task {
            do { try await HarnessService.setSkill(agent: agent.id, skill: id, on: on, orgId: at.orgId, base: at.base) }
            catch { message = error.localizedDescription; await load(at) }
        }
    }
}

struct HarnessSkillsView: View {
    @EnvironmentObject private var appState: AppState
    @State private var skills: [HarnessService.Skill]?
    @State private var editing: Draft?
    @State private var message: String?

    struct Draft: Identifiable {
        var id: String { skillId ?? "new" }
        var skillId: String?
        var name = ""
        var description = ""
        var body = ""
    }

    var body: some View {
        if let at = HarnessWhere(appState) {
            List {
                Section {
                    Text(String(localized: "How your team does a thing, written once in Markdown. Give it to any agent and it follows it."))
                        .font(Theme.TypeScale.caption).foregroundStyle(Theme.Colors.textSecondary)
                    HarnessError(message: message)
                }
                Section {
                    if skills == nil { ProgressView() }
                    if skills?.isEmpty == true { Text(String(localized: "No skills yet.")).foregroundStyle(Theme.Colors.textSecondary) }
                    ForEach(skills ?? []) { s in
                        Button { editing = Draft(skillId: s.id, name: s.name, description: s.description, body: s.body) } label: {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(s.name).font(.subheadline)
                                Text(s.description.isEmpty ? String(s.body.prefix(100)) : s.description)
                                    .font(Theme.TypeScale.caption).foregroundStyle(Theme.Colors.textSecondary)
                            }
                        }
                        .buttonStyle(.plain)
                        .swipeActions {
                            Button(String(localized: "Delete"), role: .destructive) {
                                Task {
                                    do { try await HarnessService.deleteSkill(s.id, orgId: at.orgId, base: at.base); await load(at) }
                                    catch { message = error.localizedDescription }
                                }
                            }
                        }
                    }
                }
            }
            .navigationTitle(String(localized: "Skills"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button { editing = Draft() } label: { Image(systemName: "plus") }.accessibilityLabel(String(localized: "New"))
                }
            }
            .sheet(item: $editing) { draft in
                HarnessSkillEditor(draft: draft) { d in
                    try await HarnessService.saveSkill(id: d.skillId, name: d.name, description: d.description, body: d.body, orgId: at.orgId, base: at.base)
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
        do { skills = try await HarnessService.skills(orgId: at.orgId, base: at.base) }
        catch { skills = skills ?? []; message = error.localizedDescription }
    }
}

struct HarnessSkillEditor: View {
    @State var draft: HarnessSkillsView.Draft
    let onSave: (HarnessSkillsView.Draft) async throws -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var busy = false
    @State private var message: String?

    var body: some View {
        NavigationStack {
            Form {
                TextField(String(localized: "Skill name"), text: $draft.name)
                TextField(String(localized: "One line on when to use it"), text: $draft.description)
                Section(String(localized: "Skill")) {
                    TextEditor(text: $draft.body).frame(minHeight: 200)
                }
                HarnessError(message: message)
            }
            .navigationTitle(draft.skillId == nil ? String(localized: "New") : String(localized: "Edit"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(String(localized: "Cancel")) { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(String(localized: "Save")) {
                        busy = true
                        Task {
                            defer { busy = false }
                            do { try await onSave(draft); dismiss() } catch { message = error.localizedDescription }
                        }
                    }
                    .disabled(busy || draft.name.trimmingCharacters(in: .whitespaces).isEmpty || draft.body.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
        }
    }
}
