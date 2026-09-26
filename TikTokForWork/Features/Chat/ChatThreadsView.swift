import SwiftUI

/// Threads: every thread you started, answered or were named in, the newest
/// reply first — its first message and the last replies. Opening one reads
/// it, here and on every other device.
struct ChatThreadsView: View {
    @ObservedObject var store: ChatStore
    @State private var open = false

    var body: some View {
        List {
            if store.threads.isEmpty {
                ContentUnavailableView("No threads yet", systemImage: "bubble.left.and.bubble.right", description: Text("Reply in a thread, or be named in one, and it is kept here."))
                    .listRowBackground(Color.clear)
            }
            ForEach(store.threads) { item in
                Button {
                    Task { await store.openThread(item.parent); await store.markThreadRead(item) }
                    open = true
                } label: { row(item) }
                .buttonStyle(.plain)
            }
        }
        .listStyle(.plain)
        .navigationTitle("Threads")
        .refreshable { await store.loadThreads() }
        .task { await store.loadThreads() }
        .sheet(isPresented: $open, onDismiss: { Task { await store.loadThreads() } }) {
            ChatThreadSheet(store: store, onOpenCard: { _ in })
        }
    }

    private func row(_ item: ChatThreadItem) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Text(verbatim: place(item.parent.channel)).font(.caption.weight(.bold)).foregroundStyle(Theme.Colors.textSecondary)
                if item.unread { Circle().fill(Theme.Colors.interactive).frame(width: 8, height: 8).accessibilityLabel("New replies") }
                Spacer()
                if let at = ChatDates.parse(item.lastReplyAt) { Text(at, style: .relative).font(.caption2).foregroundStyle(Theme.Colors.textTertiary) }
            }
            line(item.parent, first: true)
            ForEach(item.replies) { line($0, first: false) }
            if item.replyCount > item.replies.count {
                Text(String(localized: "\(item.replyCount - item.replies.count) more replies")).font(.caption.weight(.semibold)).foregroundStyle(Theme.Colors.interactive)
            }
        }
        .padding(.vertical, 6)
        .fontWeight(item.unread ? .semibold : nil)
    }

    private func line(_ m: ChatMessage, first: Bool) -> some View {
        HStack(alignment: .top, spacing: 8) {
            ChatAvatar(name: author(m), isAI: m.isAI, size: first ? 26 : 20, url: store.assets.avatar(of: m))
            VStack(alignment: .leading, spacing: 1) {
                Text(verbatim: author(m)).font(.footnote.weight(.bold))
                Text(verbatim: m.body.isEmpty ? "📎" : m.body).font(.subheadline).lineLimit(first ? 4 : 2)
            }
        }
        .padding(.leading, first ? 0 : 14)
    }

    private func author(_ m: ChatMessage) -> String {
        m.isAI ? String(localized: "Your AI") : (m.mine ? String(localized: "You") : (m.authorName ?? String(localized: "a teammate")))
    }

    private func place(_ view: String) -> String {
        guard let c = store.conversation(for: view) else { return "" }
        return c.kind == .channel ? (c.isPrivate ? "🔒 \(c.name)" : "#\(c.name)") : c.name
    }
}

/// Forward a message into another conversation, with a word of your own.
/// From a DM, a group or a private channel only a link goes.
struct ChatForwardSheet: View {
    @ObservedObject var store: ChatStore
    let message: ChatMessage
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @State private var target: String?
    @State private var comment = ""
    @State private var busy = false
    @State private var webLink: String?

    private var places: [ChatConversation] {
        let all = store.channels + store.groupConversations + store.people
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        return all.filter { $0.view != message.channel && (q.isEmpty || $0.name.lowercased().contains(q)) }
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Text(verbatim: message.body.isEmpty ? "📎" : String(message.body.prefix(240))).font(.subheadline).foregroundStyle(Theme.Colors.textSecondary).lineLimit(4)
                } footer: {
                    Text(store.isClosed(message.channel)
                         ? String(localized: "This is from a private conversation, so only a link goes. Whoever can read the original can open it.")
                         : String(localized: "The message goes with a line saying where it came from, and a link to it."))
                }
                Section {
                    TextField(String(localized: "Add a message (optional)"), text: $comment, axis: .vertical).lineLimit(1...4)
                }
                Section {
                    ForEach(places) { c in
                        Button { target = c.view } label: {
                            HStack(spacing: 10) {
                                Image(systemName: c.kind == .channel ? (c.isPrivate ? "lock.fill" : "number") : c.kind == .group ? "person.2.fill" : c.kind == .agent ? "wand.and.stars" : "person.fill")
                                    .foregroundStyle(Theme.Colors.textSecondary).frame(width: 24)
                                Text(verbatim: c.name).foregroundStyle(Theme.Colors.textPrimary)
                                Spacer()
                                if target == c.view { Image(systemName: "checkmark").foregroundStyle(Theme.Colors.accent) }
                            }
                        }
                        .accessibilityAddTraits(target == c.view ? .isSelected : [])
                    }
                } header: { Text("Where to") }
            }
            .searchable(text: $query, prompt: Text("Find a conversation"))
            .navigationTitle("Forward").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Forward") {
                        guard let target else { return }
                        busy = true
                        Task {
                            if await store.forward(message, to: target, comment: comment.trimmingCharacters(in: .whitespacesAndNewlines), webLink: webLink) { dismiss() }
                            busy = false
                        }
                    }.disabled(target == nil || busy)
                }
            }
            .task {
                // A link to the message, on the web app, for whoever can read it.
                if let base = store.baseURL, let web = await ChatJamLink.webURL(base: base) {
                    webLink = "\(web.absoluteString)/#/m/\(message.id)"
                }
            }
        }
    }
}
