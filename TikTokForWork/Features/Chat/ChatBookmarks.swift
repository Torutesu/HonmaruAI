import SwiftUI

/// Links kept at the top of a conversation — the shared sheet, the
/// dashboard — as in Slack. Tapped, one opens; held, it can be removed.
/// Anyone in the conversation may add one.
struct ChatBookmarksStrip: View {
    let view: String
    @EnvironmentObject private var appState: AppState
    @Environment(\.openURL) private var openURL
    @State private var items: [ChatBookmark] = []
    @State private var adding = false
    @State private var url = ""
    @State private var name = ""
    @State private var error: String?

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(items) { b in
                    Button { if let u = URL(string: b.url) { openURL(u) } } label: {
                        Label { Text(verbatim: b.title).lineLimit(1) } icon: { Image(systemName: "link") }
                            .font(.footnote.weight(.medium))
                            .padding(.horizontal, 10).padding(.vertical, 5)
                            .background(Theme.Colors.surface, in: Capsule())
                    }
                    .buttonStyle(.plain)
                    .contextMenu {
                        Button { UIPasteboard.general.string = b.url } label: { Label("Copy link", systemImage: "doc.on.doc") }
                        Button(role: .destructive) { Task { await remove(b) } } label: { Label("Remove", systemImage: "trash") }
                    }
                }
                Button { url = ""; name = ""; adding = true } label: {
                    Label(items.isEmpty ? "Add a bookmark" : "Add", systemImage: "plus")
                        .font(.footnote).foregroundStyle(Theme.Colors.textSecondary)
                        .padding(.horizontal, 8).padding(.vertical, 5)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(Text("Add a bookmark"))
            }
            .padding(.horizontal, 16).padding(.vertical, 6)
        }
        .background(Theme.Colors.background)
        .overlay(alignment: .bottom) { Divider() }
        .task(id: view) { await load() }
        .alert("Add a bookmark", isPresented: $adding) {
            TextField("https://…", text: $url).textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
            TextField("Name (optional)", text: $name)
            Button("Add") { Task { await add() } }
            Button("Cancel", role: .cancel) {}
        } message: { Text("Everyone in this conversation will see it.") }
        .alert("That did not save.", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
            Button("OK", role: .cancel) {}
        } message: { Text(error ?? "") }
    }

    private var orgId: String? { appState.currentUser?.teamID }

    private func load() async {
        guard let orgId, let base = appState.backendBaseURL else { return }
        items = (try? await ChatService.bookmarks(orgId: orgId, channel: view, base: base)) ?? []
    }

    private func add() async {
        guard let orgId, let base = appState.backendBaseURL else { return }
        let raw = url.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !raw.isEmpty else { return }
        let link = raw.lowercased().hasPrefix("http") ? raw : "https://\(raw)"
        do { items = try await ChatService.addBookmark(orgId: orgId, channel: view, url: link, title: name, base: base); Haptics.light() }
        catch { self.error = error.localizedDescription }
    }

    private func remove(_ b: ChatBookmark) async {
        guard let orgId, let base = appState.backendBaseURL else { return }
        do { items = try await ChatService.removeBookmark(orgId: orgId, channel: view, id: b.id, base: base) }
        catch { self.error = error.localizedDescription }
    }
}
