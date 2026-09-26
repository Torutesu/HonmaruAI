import SwiftUI
import UniformTypeIdentifiers

/// An agent being written or changed, as the editor holds it.
struct AgentDraft: Identifiable, Hashable {
    /// The agent's id, or a fresh one for an agent not yet made.
    var id: String = UUID().uuidString
    /// Set when it already exists: saving changes it rather than making one.
    var agentId: String?
    var name = ""
    var handle = ""
    var emoji = ""
    var description = ""
    var instructions = ""
    /// "team" or "personal".
    var scope = "team"
    /// The preset it started from, if any.
    var preset: String?
    var canEdit = true
    /// Only its maker moves an agent between the team and themselves.
    var canChangeScope = true
    var createdByName: String?
    var updatedByName: String?

    init() {}

    init(agent: ChatAgent) {
        id = agent.id
        agentId = agent.id
        name = agent.name
        handle = agent.handle
        emoji = agent.emoji ?? ""
        description = agent.description ?? ""
        instructions = agent.instructions ?? ""
        scope = agent.isPersonal ? "personal" : "team"
        preset = agent.preset
        canEdit = agent.canEdit ?? false
        canChangeScope = agent.mine ?? false
        createdByName = agent.createdByName
        updatedByName = agent.updatedByName
    }

    init(preset p: ChatAgentPreset) {
        name = p.name
        handle = p.handle
        emoji = p.emoji ?? ""
        description = p.description
        instructions = p.instructions
        preset = p.id
    }

    var isNew: Bool { agentId == nil }

    /// What follows "@": as written, or made from the name when left empty.
    var cleanHandle: String {
        let raw = handle.trimmingCharacters(in: .whitespacesAndNewlines)
        let source = raw.isEmpty ? name : raw
        let trimmed = source.drop { $0 == "@" || $0 == "＠" }
        return String(trimmed).lowercased().filter { $0.isLetter || $0.isNumber || $0 == "_" || $0 == "." || $0 == "-" }
    }
}

/// The team's agents: "@hayao" is a teammate that is instructions, written
/// in Markdown. Team agents are everyone's to call and improve; personal
/// ones answer only you. Start from a preset, write one, or bring a .md.
@MainActor
struct AgentsView: View {
    var store: ChatStore?
    @EnvironmentObject private var appState: AppState

    @State private var agents: [ChatAgent] = []
    @State private var presets: [ChatAgentPreset] = []
    @State private var loading = false
    @State private var error: String?
    @State private var editing: AgentDraft?
    @State private var confirmDelete: ChatAgent?
    @State private var importing = false
    @State private var files: [String: URL] = [:]
    /// The agent conversation being opened (`ag:<id>`), pushed on whichever
    /// stack shows this screen — Chat's or You's.
    @State private var messaging: String?

    private var orgId: String? { appState.currentUser?.teamID }
    private var base: URL? { appState.backendBaseURL }
    private var teamAgents: [ChatAgent] { agents.filter { !$0.isPersonal } }
    private var personalAgents: [ChatAgent] { agents.filter(\.isPersonal) }

    var body: some View {
        List {
            Section {
                Text("Write an agent in Markdown, then call it by its @name in any conversation. It answers in the thread under your message.")
                    .font(.subheadline).foregroundStyle(Theme.Colors.textSecondary)
                    .padding(16)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .glassPanel(cornerRadius: 18)
            }
            .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
            .listRowSeparator(.hidden)
            .listRowBackground(Color.clear)

            if loading && agents.isEmpty && presets.isEmpty {
                Section { ProgressView().frame(maxWidth: .infinity) }.listRowBackground(Color.clear)
            }

            Section {
                if teamAgents.isEmpty {
                    Text("No team agents yet. Add one from a preset below, or write your own.")
                        .font(.footnote).foregroundStyle(Theme.Colors.textSecondary)
                }
                ForEach(teamAgents) { row($0) }
            } header: {
                Text("Your team's agents")
            } footer: {
                Text("Anyone on the team can call these and improve their instructions.")
            }

            Section {
                if personalAgents.isEmpty {
                    Text("Agents only you can call show up here.")
                        .font(.footnote).foregroundStyle(Theme.Colors.textSecondary)
                }
                ForEach(personalAgents) { row($0) }
            } header: {
                Text("Only you")
            }

            if !presets.isEmpty {
                Section {
                    ForEach(presets) { presetRow($0) }
                } header: {
                    Text("Start from a preset")
                }
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(Theme.Colors.surface)
        .navigationTitle("Custom agents")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button { editing = AgentDraft() } label: { Label("New agent", systemImage: "square.and.pencil") }
                    Button { importing = true } label: { Label("Import a .md file", systemImage: "square.and.arrow.down") }
                } label: {
                    Image(systemName: "plus")
                }
                .accessibilityLabel("Add an agent")
                .disabled(appState.isGuest)
            }
        }
        .navigationDestination(item: $messaging) { view in
            if let store {
                ConversationView(view: view, jump: nil, store: store)
                    .environmentObject(appState)
                    .environment(\.chatAssets, ChatAssets(emoji: store.emoji, base: store.baseURL))
            }
        }
        .task(id: orgId) { await load() }
        .refreshable { await load() }
        .sheet(item: $editing) { draft in
            AgentEditorSheet(draft: draft, exportURL: draft.agentId.flatMap { files[$0] }) { saved in
                await save(saved)
            }
        }
        .fileImporter(isPresented: $importing, allowedContentTypes: [.plainText, UTType(filenameExtension: "md") ?? .plainText], allowsMultipleSelection: false) { result in
            switch result {
            case .success(let urls):
                guard let url = urls.first else { return }
                Task { await importFile(url) }
            case .failure(let err):
                error = err.localizedDescription
            }
        }
        .confirmationDialog(
            Text("Delete this agent? What it already wrote stays."),
            isPresented: Binding(get: { confirmDelete != nil }, set: { if !$0 { confirmDelete = nil } }),
            titleVisibility: .visible
        ) {
            Button("Delete agent", role: .destructive) {
                if let a = confirmDelete { Task { await delete(a) } }
                confirmDelete = nil
            }
            Button("Cancel", role: .cancel) { confirmDelete = nil }
        }
        .alert("Custom agents", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
            Button("OK", role: .cancel) { error = nil }
        } message: {
            Text(error ?? "")
        }
    }

    // MARK: Rows

    private func row(_ a: ChatAgent) -> some View {
        HStack(spacing: 8) {
            rowLabel(a)
            if store != nil {
                Button { message(a) } label: {
                    Image(systemName: "bubble.left")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(Theme.Colors.interactive)
                        .frame(width: 36, height: 36)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.borderless)
                .accessibilityLabel(Text("Message \(a.name)"))
            }
        }
        .swipeActions(edge: .leading, allowsFullSwipe: true) {
            if store != nil {
                Button { message(a) } label: { Label("Message", systemImage: "bubble.left") }
                    .tint(Theme.Colors.accent)
            }
        }
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            if a.canDelete == true {
                Button(role: .destructive) { confirmDelete = a } label: { Label("Delete", systemImage: "trash") }
            }
            if a.canEdit == true {
                Button { editing = AgentDraft(agent: a) } label: { Label("Edit", systemImage: "pencil") }
                    .tint(Theme.Colors.interactive)
            }
        }
        .contextMenu {
            if store != nil {
                Button { message(a) } label: { Label("Message", systemImage: "bubble.left") }
            }
            if a.canEdit == true {
                Button { editing = AgentDraft(agent: a) } label: { Label("Edit", systemImage: "pencil") }
            }
            if let url = files[a.id] {
                ShareLink(item: url) { Label("Export as .md", systemImage: "square.and.arrow.up") }
            }
            if a.canDelete == true {
                Button(role: .destructive) { confirmDelete = a } label: { Label("Delete agent", systemImage: "trash") }
            }
        }
    }

    /// Opens your own conversation with this agent.
    private func message(_ a: ChatAgent) {
        messaging = ChatConversation.agentView(a.id)
    }

    private func rowLabel(_ a: ChatAgent) -> some View {
        Button {
            editing = AgentDraft(agent: a)
        } label: {
            HStack(spacing: 12) {
                ChatAvatar(name: a.name, size: 40, agentEmoji: a.glyph)
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text(verbatim: a.name).font(.body.weight(.semibold)).foregroundStyle(Theme.Colors.textPrimary).lineLimit(1)
                        Text(verbatim: "@\(a.handle)").font(.caption).foregroundStyle(Theme.Colors.textTertiary).lineLimit(1)
                    }
                    if let d = a.description, !d.isEmpty {
                        Text(verbatim: d).font(.footnote).foregroundStyle(Theme.Colors.textSecondary).lineLimit(2)
                    }
                    if let who = a.createdByName, !who.isEmpty, a.mine != true {
                        Text("Made by \(who)").font(.caption2).foregroundStyle(Theme.Colors.textTertiary)
                    }
                }
                Spacer(minLength: 0)
                if a.canEdit != true {
                    Image(systemName: "lock").font(.caption).foregroundStyle(Theme.Colors.textTertiary)
                        .accessibilityLabel("Read only")
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func presetRow(_ p: ChatAgentPreset) -> some View {
        let added = agents.contains { $0.preset == p.id }
        return HStack(spacing: 12) {
            ChatAvatar(name: p.name, size: 40, agentEmoji: ChatAgent.glyph(p.emoji))
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: p.name).font(.body.weight(.semibold)).foregroundStyle(Theme.Colors.textPrimary)
                Text(verbatim: p.description).font(.footnote).foregroundStyle(Theme.Colors.textSecondary).lineLimit(2)
            }
            Spacer(minLength: 8)
            Button {
                editing = AgentDraft(preset: p)
            } label: {
                Text(added ? LocalizedStringKey("Add again") : LocalizedStringKey("Add"))
                    .font(.footnote.weight(.semibold))
                    .padding(.horizontal, 12).padding(.vertical, 6)
                    .glassCapsule(interactive: true)
            }
            .buttonStyle(.plain)
            .disabled(appState.isGuest)
        }
    }

    // MARK: Talking to the Worker

    private func load() async {
        guard let orgId, let base else { return }
        loading = true
        defer { loading = false }
        do {
            let out = try await ChatService.agents(orgId: orgId, locale: appState.readerLanguageCode, base: base)
            apply(out.agents)
            presets = out.presets ?? []
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func apply(_ list: [ChatAgent]) {
        agents = list
        store?.setAgents(list)
        files = AgentFiles.write(list)
    }

    /// Nil when saved; otherwise what went wrong, for the editor to say.
    private func save(_ d: AgentDraft) async -> String? {
        guard let orgId, let base else { return String(localized: "Sign in to talk with your team.") }
        do {
            let out: ChatService.AgentSaved
            if let id = d.agentId {
                out = try await ChatService.updateAgent(
                    orgId: orgId, id: id, name: d.name.trimmingCharacters(in: .whitespacesAndNewlines), handle: d.cleanHandle,
                    emoji: d.emoji.trimmingCharacters(in: .whitespaces), description: d.description,
                    instructions: d.instructions, scope: d.scope, base: base)
            } else {
                out = try await ChatService.createAgent(
                    orgId: orgId, name: d.name.trimmingCharacters(in: .whitespacesAndNewlines), handle: d.cleanHandle,
                    emoji: d.emoji.trimmingCharacters(in: .whitespaces), description: d.description,
                    instructions: d.instructions, scope: d.scope, preset: d.preset, base: base)
            }
            apply(out.agents)
            Haptics.success()
            return nil
        } catch {
            return error.localizedDescription
        }
    }

    private func delete(_ a: ChatAgent) async {
        guard let orgId, let base else { return }
        do {
            apply(try await ChatService.deleteAgent(orgId: orgId, id: a.id, base: base))
        } catch {
            self.error = error.localizedDescription
        }
    }

    /// A .md file from Files: read here, understood by the Worker.
    private func importFile(_ url: URL) async {
        guard let orgId, let base else { return }
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        let text: String
        do {
            text = try String(contentsOf: url, encoding: .utf8)
        } catch {
            self.error = String(localized: "That file could not be read. Choose a Markdown (.md) or text file.")
            return
        }
        do {
            let out = try await ChatService.createAgent(fromMarkdown: text, orgId: orgId, base: base)
            apply(out.agents)
            Haptics.success()
            if let made = out.agent { editing = AgentDraft(agent: made) }
        } catch {
            self.error = error.localizedDescription
        }
    }
}

/// Each agent as a .md file in the temporary folder, for sharing.
enum AgentFiles {
    static func write(_ agents: [ChatAgent]) -> [String: URL] {
        var out: [String: URL] = [:]
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("agents", isDirectory: true)
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        for a in agents {
            guard let md = a.markdown, !md.isEmpty else { continue }
            let url = folder.appendingPathComponent("\(a.handle).md")
            if (try? md.write(to: url, atomically: true, encoding: .utf8)) != nil { out[a.id] = url }
        }
        return out
    }
}

/// Writing an agent: who it is, who may call it, and its instructions in
/// Markdown — with a preview of how they read.
struct AgentEditorSheet: View {
    @State private var draft: AgentDraft
    var exportURL: URL?
    let onSave: (AgentDraft) async -> String?

    @Environment(\.dismiss) private var dismiss
    @State private var preview = false
    @State private var saving = false
    @State private var problem: String?

    init(draft: AgentDraft, exportURL: URL? = nil, onSave: @escaping (AgentDraft) async -> String?) {
        _draft = State(initialValue: draft)
        _preview = State(initialValue: !draft.canEdit)
        self.exportURL = exportURL
        self.onSave = onSave
    }

    private var readOnly: Bool { !draft.canEdit }
    private var canSave: Bool {
        !readOnly && !saving
            && !draft.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !draft.instructions.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    HStack(spacing: 12) {
                        ChatAvatar(name: draft.name, size: 44, agentEmoji: ChatAgent.glyph(draft.emoji))
                        VStack(alignment: .leading, spacing: 2) {
                            Text(verbatim: draft.name.isEmpty ? String(localized: "New agent") : draft.name).font(.headline)
                            Text(verbatim: "@\(draft.cleanHandle)").font(.caption).foregroundStyle(Theme.Colors.textSecondary)
                        }
                    }
                    TextField("Name", text: $draft.name)
                    HStack(spacing: 2) {
                        Text(verbatim: "@").foregroundStyle(Theme.Colors.textTertiary)
                        TextField("handle", text: $draft.handle)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                    }
                    TextField("Emoji", text: $draft.emoji)
                    TextField("What it does, in one line", text: $draft.description, axis: .vertical)
                        .lineLimit(1...3)
                } footer: {
                    Text("Call it by writing @\(draft.cleanHandle) in any conversation.")
                }
                .disabled(readOnly)

                Section {
                    Picker("Who can call it", selection: $draft.scope) {
                        Text("Everyone").tag("team")
                        Text("Only me").tag("personal")
                    }
                    .pickerStyle(.segmented)
                    .disabled(readOnly || !draft.canChangeScope)
                } header: {
                    Text("Who can call it")
                } footer: {
                    Text(draft.scope == "personal"
                         ? LocalizedStringKey("Only you can call it, and only you see its instructions.")
                         : LocalizedStringKey("Anyone on the team can call it and improve its instructions."))
                }

                Section {
                    Toggle("Preview", isOn: $preview)
                    if preview {
                        AgentMarkdownPreview(text: draft.instructions)
                            .padding(.vertical, 4)
                    } else {
                        TextEditor(text: $draft.instructions)
                            .font(.system(.footnote, design: .monospaced))
                            .frame(minHeight: 260)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .disabled(readOnly)
                    }
                } header: {
                    Text("Instructions")
                } footer: {
                    Text(String(localized: "Markdown: who it is, what it does and how it answers. # headings, - lists, **bold**."))
                }

                if let who = draft.createdByName, !who.isEmpty {
                    Section {
                        LabeledContent("Made by", value: who)
                        if let editor = draft.updatedByName, !editor.isEmpty {
                            LabeledContent("Last edited by", value: editor)
                        }
                    }
                }

                if let problem {
                    Section {
                        Label(problem, systemImage: "exclamationmark.triangle").foregroundStyle(Theme.Colors.reject)
                    }
                }
            }
            .scrollDismissesKeyboard(.interactively)
            .navigationTitle(draft.isNew ? LocalizedStringKey("New agent") : (readOnly ? LocalizedStringKey("Agent") : LocalizedStringKey("Edit agent")))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(readOnly ? LocalizedStringKey("Close") : LocalizedStringKey("Cancel")) { dismiss() }
                }
                if let exportURL {
                    ToolbarItem(placement: .topBarTrailing) {
                        ShareLink(item: exportURL) { Image(systemName: "square.and.arrow.up") }
                            .accessibilityLabel("Export as .md")
                    }
                }
                if !readOnly {
                    ToolbarItem(placement: .confirmationAction) {
                        if saving {
                            ProgressView()
                        } else {
                            Button("Save") {
                                saving = true
                                problem = nil
                                Task {
                                    let failure = await onSave(draft)
                                    saving = false
                                    if let failure { problem = failure } else { dismiss() }
                                }
                            }
                            .disabled(!canSave)
                        }
                    }
                }
            }
        }
        .presentationDragIndicator(.visible)
    }
}

/// An agent's Markdown as it reads: headings, lists and inline marks.
struct AgentMarkdownPreview: View {
    let text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(Array(text.components(separatedBy: "\n").enumerated()), id: \.offset) { _, line in
                lineView(line)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .textSelection(.enabled)
    }

    @ViewBuilder
    private func lineView(_ line: String) -> some View {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        if trimmed.hasPrefix("### ") {
            Text(inline(String(trimmed.dropFirst(4)))).font(.subheadline.weight(.semibold))
        } else if trimmed.hasPrefix("## ") {
            Text(inline(String(trimmed.dropFirst(3)))).font(.headline).padding(.top, 4)
        } else if trimmed.hasPrefix("# ") {
            Text(inline(String(trimmed.dropFirst(2)))).font(.title3.weight(.bold)).padding(.top, 2)
        } else if trimmed.hasPrefix("- ") || trimmed.hasPrefix("* ") || trimmed.hasPrefix("• ") {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(verbatim: "•").foregroundStyle(Theme.Colors.textSecondary)
                Text(inline(String(trimmed.dropFirst(2))))
            }
        } else if trimmed.hasPrefix("> ") {
            HStack(spacing: 8) {
                RoundedRectangle(cornerRadius: 2).fill(Theme.Colors.border).frame(width: 3)
                Text(inline(String(trimmed.dropFirst(2)))).foregroundStyle(Theme.Colors.textSecondary)
            }.fixedSize(horizontal: false, vertical: true)
        } else if trimmed.isEmpty {
            Color.clear.frame(height: 2)
        } else {
            Text(inline(line))
        }
    }

    private func inline(_ s: String) -> AttributedString {
        let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        return (try? AttributedString(markdown: s, options: options)) ?? AttributedString(s)
    }
}
