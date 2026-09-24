import SwiftUI

/// The chat tab: Activity and Later on glass at the top, then channels and
/// the people you work with — the Slack sidebar, laid out for a phone.
struct ChatHomeView: View {
    @EnvironmentObject private var appState: AppState
    @ObservedObject var store: ChatStore
    @State private var path: [ChatRoute] = []
    @State private var query = ""
    @State private var results: [ChatMessage] = []
    @State private var creating = false
    @State private var newChannel = ""
    @State private var editingStatus = false

    var body: some View {
        NavigationStack(path: $path) {
            List {
                if query.trimmingCharacters(in: .whitespaces).count >= 2 {
                    searchResults
                } else {
                    Section { shortcuts }
                        .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
                        .listRowSeparator(.hidden)
                        .listRowBackground(Color.clear)
                    if store.channels.isEmpty && store.people.isEmpty {
                        Section { gettingStarted }.listRowBackground(Color.clear).listRowSeparator(.hidden)
                    }
                    Section {
                        ForEach(store.channels) { row($0) }
                        Button { creating = true } label: {
                            Label("Add a channel", systemImage: "plus").foregroundStyle(Theme.Colors.textSecondary)
                        }
                    } header: { Text("Channels") }
                    if !store.people.isEmpty {
                        Section { ForEach(store.people) { row($0) } } header: { Text("Direct messages") }
                    }
                }
            }
            .listStyle(.insetGrouped)
            .scrollContentBackground(.hidden)
            .background(Theme.Colors.surface)
            .navigationTitle("Chat")
            .searchable(text: $query, prompt: Text("Search messages"))
            .task(id: query) {
                let q = query
                guard q.trimmingCharacters(in: .whitespaces).count >= 2 else { results = []; return }
                try? await Task.sleep(for: .milliseconds(280))
                guard !Task.isCancelled else { return }
                results = await store.search(q)
            }
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { editingStatus = true } label: {
                        if let e = store.mine?.status?.emoji, !e.isEmpty { Text(e) } else { Image(systemName: "face.smiling") }
                    }.accessibilityLabel("Set your status")
                }
            }
            .refreshable { await store.refresh(); await store.loadInbox() }
            .navigationDestination(for: ChatRoute.self) { route in
                switch route {
                case let .conversation(view, jump): ConversationView(view: view, jump: jump, store: store)
                case .activity: ChatActivityView(store: store)
                case .later: ChatLaterView(store: store)
                }
            }
            .alert("New channel", isPresented: $creating) {
                TextField("e.g. marketing", text: $newChannel)
                Button("Create") {
                    let name = newChannel.trimmingCharacters(in: .whitespaces)
                    newChannel = ""
                    guard !name.isEmpty else { return }
                    Task { await store.createChannel(name) }
                }
                Button("Cancel", role: .cancel) { newChannel = "" }
            } message: { Text("A channel for one business or project. Everyone on the team can see it.") }
            .sheet(isPresented: $editingStatus) { ChatStatusEditor(store: store).environmentObject(appState) }
        }
        .task(id: appState.currentUser?.teamID) {
            store.bind(appState)
            await store.refresh()
            await store.loadInbox()
        }
    }

    // MARK: Parts

    private var shortcuts: some View {
        GlassGroup(spacing: 10) {
            HStack(spacing: 10) {
                shortcut("Activity", icon: "bell", badge: store.unreadInbox, route: .activity)
                shortcut("Later", icon: "bookmark", badge: store.saved.count, route: .later)
            }
        }
    }

    private func shortcut(_ title: LocalizedStringKey, icon: String, badge: Int, route: ChatRoute) -> some View {
        Button { path.append(route) } label: {
            HStack(spacing: 8) {
                Image(systemName: icon).font(.system(size: 16, weight: .semibold))
                Text(title).font(.subheadline.weight(.semibold))
                Spacer(minLength: 0)
                if badge > 0 {
                    Text(verbatim: "\(badge)").font(.caption.weight(.bold)).foregroundStyle(.white)
                        .padding(.horizontal, 7).padding(.vertical, 2).background(Theme.Colors.reject, in: Capsule())
                }
            }
            .foregroundStyle(Theme.Colors.textPrimary)
            .padding(.horizontal, 16).padding(.vertical, 12)
            .frame(maxWidth: .infinity)
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .glassCapsule(interactive: true)
    }

    private var gettingStarted: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Getting started", systemImage: "sparkles").font(.headline)
            Text("Add a business in Tools and it becomes a channel. Invite teammates and they show up under Direct messages. Write @ and a name to bring someone — or your AI — in.")
                .font(.subheadline).foregroundStyle(Theme.Colors.textSecondary)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassPanel()
    }

    private func row(_ c: ChatConversation) -> some View {
        let fresh = store.isFresh(c.view)
        let mentions = store.mentions(in: c.view)
        return NavigationLink(value: ChatRoute.conversation(view: c.view, jump: nil)) {
            HStack(spacing: 10) {
                if c.kind == .channel {
                    Image(systemName: "number").font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(Theme.Colors.textSecondary).frame(width: 28)
                } else {
                    ChatAvatar(name: c.name, size: 28)
                        .overlay(alignment: .bottomTrailing) {
                            if ChatDates.parse(c.member?.awayUntil).map({ $0 > Date() }) == true {
                                Circle().stroke(Theme.Colors.textTertiary, lineWidth: 2).background(Circle().fill(Theme.Colors.surface))
                                    .frame(width: 9, height: 9).offset(x: 2, y: 2)
                            }
                        }
                }
                Text(c.name).font(.body.weight(fresh ? .bold : .regular)).lineLimit(1)
                if let e = c.member?.status?.emoji, !e.isEmpty { Text(e).font(.subheadline) }
                Spacer(minLength: 4)
                if store.hasDraft(c.view) { Image(systemName: "pencil").font(.caption).foregroundStyle(Theme.Colors.textTertiary).accessibilityLabel("Draft") }
                if store.prefs[c.view] == "mute" { Image(systemName: "bell.slash").font(.caption).foregroundStyle(Theme.Colors.textTertiary).accessibilityLabel("Muted") }
                if mentions > 0 {
                    Text(verbatim: "\(mentions)").font(.caption.weight(.bold)).foregroundStyle(.white)
                        .padding(.horizontal, 7).padding(.vertical, 2).background(Theme.Colors.reject, in: Capsule())
                } else if fresh {
                    Circle().fill(Theme.Colors.interactive).frame(width: 8, height: 8).accessibilityLabel("Unread")
                }
            }
        }
    }

    @ViewBuilder private var searchResults: some View {
        if results.isEmpty {
            ContentUnavailableView.search(text: query)
        } else {
            ForEach(results) { m in
                NavigationLink(value: ChatRoute.conversation(view: m.channel, jump: m.parentId ?? m.id)) {
                    VStack(alignment: .leading, spacing: 3) {
                        HStack {
                            Text(place(m.channel)).font(.caption.weight(.semibold)).foregroundStyle(Theme.Colors.textSecondary)
                            Spacer()
                            Text(m.date, style: .date).font(.caption2).foregroundStyle(Theme.Colors.textTertiary)
                        }
                        Text(m.isAI ? String(localized: "Your AI") : (m.mine ? String(localized: "You") : m.authorName ?? "")).font(.subheadline.weight(.semibold))
                        Text(m.body).font(.subheadline).lineLimit(3)
                    }.padding(.vertical, 2)
                }
            }
        }
    }

    private func place(_ view: String) -> String {
        guard let c = store.conversation(for: view) else { return "" }
        return c.kind == .channel ? "#\(c.name)" : c.name
    }
}
