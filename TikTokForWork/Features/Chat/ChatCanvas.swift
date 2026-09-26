import SwiftUI

/// A conversation's canvas: one shared document — how things are done,
/// what was decided, who owns what — that anyone in it reads and edits.
/// A save names the version it was made from; if somebody else saved in
/// between, this says so instead of writing over theirs.
struct ChatCanvasSheet: View {
    let view: String
    let title: String
    @EnvironmentObject private var appState: AppState
    @Environment(\.dismiss) private var dismiss
    @State private var canvas: ChatCanvas?
    @State private var editing: String?
    @State private var baseVersion = 0
    @State private var conflict: ChatCanvas?
    @State private var busy = false
    @State private var note: String?
    @State private var error: String?

    private var orgId: String? { appState.currentUser?.teamID }

    var body: some View {
        NavigationStack {
            Group {
                if let editing {
                    TextEditor(text: Binding(get: { editing }, set: { self.editing = $0 }))
                        .font(.system(.body, design: .monospaced))
                        .padding(.horizontal, 12)
                        .accessibilityLabel(Text("Canvas"))
                } else if let canvas {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 12) {
                            if canvas.body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                                ContentUnavailableView("Nothing here yet", systemImage: "doc.richtext",
                                                       description: Text("A shared document for this conversation: how things are done, what was decided, who owns what. Anyone here can edit it."))
                            } else {
                                CanvasText(source: canvas.body)
                                if let by = canvas.updatedBy, let at = ChatDates.parse(canvas.updatedAt) {
                                    Text("Edited by \(by) · \(at.formatted(date: .abbreviated, time: .shortened))")
                                        .font(.caption).foregroundStyle(Theme.Colors.textTertiary)
                                }
                            }
                            if let note { Text(note).font(.footnote).foregroundStyle(Theme.Colors.textSecondary) }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(16)
                    }
                } else {
                    ProgressView()
                }
            }
            .navigationTitle(title).navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(editing == nil ? "Close" : "Cancel") {
                        if editing == nil { dismiss() } else { editing = nil; conflict = nil }
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if editing != nil {
                        Button("Save") { Task { await save() } }.disabled(busy)
                    } else {
                        Button("Edit") { baseVersion = canvas?.version ?? 0; editing = canvas?.body ?? "" }.disabled(canvas == nil)
                    }
                }
                ToolbarItem(placement: .bottomBar) {
                    Button { Task { await askAI() } } label: { Label("Update from the conversation", systemImage: "sparkles") }
                        .disabled(busy || canvas == nil)
                }
            }
            .alert("Someone else changed the canvas while you were editing.", isPresented: Binding(get: { conflict != nil }, set: { if !$0 { conflict = nil } })) {
                Button("Keep mine") { if let c = conflict { baseVersion = c.version }; conflict = nil; Task { await save() } }
                Button("Use theirs") { canvas = conflict; editing = nil; conflict = nil }
                Button("Cancel", role: .cancel) {}
            }
            .alert("That did not save.", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
                Button("OK", role: .cancel) {}
            } message: { Text(error ?? "") }
            .task { await load() }
        }
    }

    private func load() async {
        guard let orgId, let base = appState.backendBaseURL else { return }
        do { canvas = try await ChatService.canvas(orgId: orgId, channel: view, base: base).0 }
        catch { self.error = error.localizedDescription }
    }

    private func save() async {
        guard let orgId, let base = appState.backendBaseURL, let text = editing else { return }
        busy = true
        defer { busy = false }
        do {
            switch try await ChatService.saveCanvas(orgId: orgId, channel: view, body: text, baseVersion: baseVersion, base: base) {
            case .saved(let saved): canvas = saved; editing = nil; Haptics.success()
            case .conflict(let theirs): conflict = theirs
            }
        } catch { self.error = error.localizedDescription }
    }

    private func askAI() async {
        guard let orgId, let base = appState.backendBaseURL else { return }
        busy = true
        defer { busy = false }
        do {
            let out = try await ChatService.draftCanvas(orgId: orgId, channel: view, body: editing ?? canvas?.body ?? "", base: base)
            if out.byModel {
                if editing == nil { baseVersion = canvas?.version ?? 0 }
                editing = out.body
            }
            note = out.note
        } catch { self.error = error.localizedDescription }
    }
}

/// The canvas as a reader sees it: headings, bullets and to-dos drawn,
/// inline emphasis and links through the system's Markdown.
private struct CanvasText: View {
    let source: String
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(Array(source.components(separatedBy: "\n").enumerated()), id: \.offset) { _, raw in
                line(raw)
            }
        }
    }

    @ViewBuilder private func line(_ raw: String) -> some View {
        let text = raw.trimmingCharacters(in: .whitespaces)
        if text.hasPrefix("## ") || text.hasPrefix("# ") {
            Text(inline(String(text.drop(while: { $0 == "#" }).dropFirst()))).font(.title3.weight(.bold)).padding(.top, 6)
        } else if text.hasPrefix("### ") {
            Text(inline(String(text.dropFirst(4)))).font(.headline)
        } else if text.hasPrefix("- [ ] ") || text.hasPrefix("- [x] ") || text.hasPrefix("- [X] ") {
            let done = !text.hasPrefix("- [ ] ")
            Label { Text(inline(String(text.dropFirst(6)))).strikethrough(done).foregroundStyle(done ? Theme.Colors.textTertiary : Theme.Colors.textPrimary) }
                icon: { Image(systemName: done ? "checkmark.square.fill" : "square") }
        } else if text.hasPrefix("- ") || text.hasPrefix("* ") {
            HStack(alignment: .firstTextBaseline, spacing: 8) { Text("•"); Text(inline(String(text.dropFirst(2)))) }
        } else if text.isEmpty {
            Color.clear.frame(height: 4)
        } else {
            Text(inline(text))
        }
    }

    private func inline(_ s: String) -> AttributedString {
        (try? AttributedString(markdown: s, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(s)
    }
}
