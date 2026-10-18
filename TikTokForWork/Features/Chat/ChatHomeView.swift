import SwiftUI
import UIKit

/// What a chat root shows: the Slack home (sections of channels, DMs and
/// agents under a row of shortcuts), your DMs, or Activity.
enum ChatHomeMode { case home, dms, activity }

/// The Slack sidebar, laid out for a phone. Home is the channel list under
/// the workspace header; DMs and Activity are tabs of their own, as in
/// Slack's app. Every conversation opens from here, full screen.
struct ChatHomeView: View {
    @EnvironmentObject private var appState: AppState
    @ObservedObject var store: ChatStore
    var mode: ChatHomeMode = .home
    /// Home's header (the workspace, Cards or List, search, you), handed the
    /// way to open search.
    var header: ((@escaping () -> Void) -> AnyView)? = nil
    @State private var path: [ChatRoute] = []
    @State private var creating = false
    @State private var newChannel = ""
    @State private var editingStatus = false
    @State private var startingMessage = false
    @State private var pickingAgent = false
    // The long press on a conversation: renaming a channel, leaving a private one.
    @State private var renaming: ChatConversation?
    @State private var renameTo = ""
    @State private var leaving: ChatConversation?
    @State private var archiving: ChatConversation?
    @State private var menuProblem: String?
    /// Sections folded away, as Slack keeps them between launches.
    @AppStorage("chat.home.collapsed") private var collapsedRaw = ""

    var body: some View {
        NavigationStack(path: $path) {
            root
            .navigationDestination(for: ChatRoute.self) { route in
                switch route {
                case let .conversation(view, jump, thread): ConversationView(view: view, jump: jump, thread: thread, store: store)
                case .activity: ChatActivityView(store: store)
                case .later: ChatLaterView(store: store)
                case .threads: ChatThreadsView(store: store)
                case .agents: AgentsView(store: store).environmentObject(appState)
                case .archived: ChatArchivedChannelsView(store: store)
                case .sent: ChatSentView(store: store)
                case .search: ChatSearchView(store: store)
                case .catchUp: ChatCatchUpView(store: store)
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
            .alert("Rename channel", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
                TextField("Channel name", text: $renameTo)
                Button("Save") {
                    let name = renameTo.trimmingCharacters(in: .whitespacesAndNewlines)
                    guard let c = renaming, !name.isEmpty else { return }
                    Task { if let failed = await store.renameChannel(c.view, to: name) { menuProblem = failed } }
                }
                Button("Cancel", role: .cancel) {}
            } message: { Text("Everyone in the workspace sees the new name. Links to it keep working.") }
            .confirmationDialog(Text(verbatim: leaving.map { "#\($0.name)" } ?? ""), isPresented: Binding(get: { leaving != nil }, set: { if !$0 { leaving = nil } }), titleVisibility: .visible) {
                Button("Leave channel", role: .destructive) {
                    guard let c = leaving else { return }
                    Task { if let failed = await store.leaveChannel(c.view) { menuProblem = failed } }
                }
            } message: { Text("You will need somebody inside to add you again.") }
            .confirmationDialog(Text(verbatim: archiving.map { "#\($0.name)" } ?? ""), isPresented: Binding(get: { archiving != nil }, set: { if !$0 { archiving = nil } }), titleVisibility: .visible) {
                Button("Archive channel", role: .destructive) {
                    guard let c = archiving else { return }
                    Task { if let failed = await store.archiveChannel(c.view) { menuProblem = failed } }
                }
            } message: { Text("It leaves everyone's sidebar. Its messages, files and decisions are kept, and it can be restored any time from Archived channels.") }
            .alert("That did not work", isPresented: Binding(get: { menuProblem != nil }, set: { if !$0 { menuProblem = nil } })) {
                Button("OK", role: .cancel) {}
            } message: { Text(verbatim: menuProblem ?? "") }
            .sheet(isPresented: $editingStatus) { ChatStatusEditor(store: store).environmentObject(appState) }
            .sheet(isPresented: $pickingAgent) {
                ChatAgentPickerSheet(agents: store.agents) { a in
                    pickingAgent = false
                    path.append(.conversation(view: ChatConversation.agentView(a.id), jump: nil))
                }
            }
            .sheet(isPresented: $startingMessage) {
                ChatNewMessageSheet(store: store) { view in
                    startingMessage = false
                    path.append(.conversation(view: view, jump: nil))
                }
            }
        }
        // The workspace's own emoji and the API's address, for every message
        // drawn below — sheets included.
        .environment(\.chatAssets, store.assets)
        .task(id: appState.currentUser?.teamID) {
            store.bind(appState)
            await store.refresh()
            await store.loadInbox()
        }
        // A tapped notification lands in Activity, on the conversation it
        // came from: scrolled to its message, or to the thread it is in.
        .onAppear { openPending() }
        .onChange(of: store.pendingOpen) { _, _ in openPending() }
    }

    private func openPending() {
        guard mode == .activity, let target = store.pendingOpen else { return }
        path = [.conversation(view: target.channel, jump: target.messageId, thread: target.parentId)]
    }

    // MARK: Roots

    @ViewBuilder private var root: some View {
        switch mode {
        case .home: homeRoot
        case .dms: dmsRoot
        case .activity:
            ChatActivityView(store: store)
                .toolbar {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button { path.append(.search) } label: { Image(systemName: "magnifyingglass") }
                            .accessibilityLabel("Search messages")
                    }
                }
                .refreshable { await store.loadInbox() }
        }
    }

    private var homeRoot: some View {
        VStack(spacing: 0) {
            if let header { header { path.append(.search) } }
            List {
                shortcutCards
                    .listRowInsets(EdgeInsets())
                    .listRowSeparator(.hidden)
                    .listRowBackground(Color.clear)
                if store.channels.isEmpty && store.people.isEmpty {
                    gettingStarted
                        .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 12, trailing: 16))
                        .listRowSeparator(.hidden).listRowBackground(Color.clear)
                }
                let unread = (store.channels + store.groupConversations + store.people + store.agentConversations)
                    .filter { store.isFresh($0.view) || store.mentions(in: $0.view) > 0 }
                if !unread.isEmpty {
                    sectionHeader("unreads", title: "Unreads") {
                        Button("Catch up") { path.append(.catchUp) }
                            .font(.footnote.weight(.semibold)).foregroundStyle(Theme.Colors.accent)
                        Button("Mark all as read") { Task { await store.markEverythingRead() } }
                            .font(.footnote.weight(.semibold)).foregroundStyle(Theme.Colors.textSecondary)
                    }
                    if !collapsed("unreads") { ForEach(unread) { row($0) } }
                }
                // Starred first, then your own sections; what they hold
                // leaves the sections below.
                if !store.sidebar.starred.isEmpty {
                    sectionHeader("starred", title: "Starred")
                    if !collapsed("starred") { ForEach(store.sidebar.starred.compactMap { store.conversation(for: $0) }) { row($0) } }
                }
                ForEach(store.sidebar.sections) { s in
                    sectionHeader("s:\(s.id)", verbatim: s.name) {
                        Button { Task { await store.removeSection(s.id) } } label: { Image(systemName: "xmark").font(.caption) }
                            .foregroundStyle(Theme.Colors.textTertiary).accessibilityLabel("Remove section")
                    }
                    if !collapsed("s:\(s.id)") {
                        ForEach(s.views.filter { !store.isStarred($0) }.compactMap { store.conversation(for: $0) }) { row($0) }
                    }
                }
                channelsSection
                dmsSection
                agentsSection
                Color.clear.frame(height: 12).listRowSeparator(.hidden).listRowBackground(Color.clear)
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .environment(\.defaultMinListRowHeight, 40)
            .refreshable { await store.refresh(); await store.loadInbox() }
        }
        .background(Theme.Colors.surface)
        .toolbar(.hidden, for: .navigationBar)
    }

    @ViewBuilder private var channelsSection: some View {
        sectionHeader("channels", title: "Channels")
        if !collapsed("channels") {
            ForEach(store.channels.filter { store.isUnplaced($0.view) }) { row($0) }
            actionRow("Add a channel", icon: "plus") { creating = true }
            actionRow("Archived channels", icon: "archivebox") { path.append(.archived) }
        }
    }

    @ViewBuilder private var dmsSection: some View {
        if !store.people.isEmpty || !store.groupConversations.isEmpty {
            sectionHeader("dms", title: "Direct messages")
            if !collapsed("dms") {
                ForEach(store.groupConversations.filter { store.isUnplaced($0.view) }) { row($0) }
                ForEach(store.people.filter { store.isUnplaced($0.view) }) { row($0) }
                actionRow("New message", icon: "plus") { startingMessage = true }
            }
        }
    }

    /// Your own conversations with the team's agents: write there and the
    /// agent answers.
    @ViewBuilder private var agentsSection: some View {
        sectionHeader("agents", title: "Custom agents")
        if !collapsed("agents") {
            ForEach(store.agentConversations.filter { store.isUnplaced($0.view) }) { row($0) }
            if !store.agents.isEmpty { actionRow("Talk to an agent", icon: "plus") { pickingAgent = true } }
            actionRow(store.agents.isEmpty ? LocalizedStringKey("Make an agent") : LocalizedStringKey("All agents"), icon: "wand.and.stars") { path.append(.agents) }
        }
    }

    private var dmsRoot: some View {
        List {
            let dms = (store.groupConversations + store.people + store.agentConversations)
                .sorted { (store.activity[$0.view]?.lastAt ?? "") > (store.activity[$1.view]?.lastAt ?? "") }
            if dms.isEmpty {
                ContentUnavailableView("No direct messages yet", systemImage: "bubble.left.and.bubble.right",
                                       description: Text("Invite teammates and they show up here. Write to one, or to a few at once."))
                    .listRowBackground(Color.clear).listRowSeparator(.hidden)
            }
            ForEach(dms) { row($0, large: true) }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(Theme.Colors.surface)
        .navigationTitle("DMs")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { path.append(.search) } label: { Image(systemName: "magnifyingglass") }
                    .accessibilityLabel("Search messages")
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button { startingMessage = true } label: { Image(systemName: "square.and.pencil") }
                    .accessibilityLabel("New message")
            }
        }
        .refreshable { await store.refresh() }
    }

    // MARK: Parts

    /// Slack's row of cards over the sidebar: each says how much is waiting.
    private var shortcutCards: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                card("Catch up", icon: "rectangle.stack", detail: String(localized: "\(store.freshViews.count) new"), alert: !store.freshViews.isEmpty, route: .catchUp)
                card("Threads", icon: "text.bubble", detail: String(localized: "\(store.unreadThreads) new"), alert: store.unreadThreads > 0, route: .threads)
                card("Later", icon: "bookmark", detail: String(localized: "\(store.saved.count) items"), alert: false, route: .later)
                card("Drafts & sent", icon: "paperplane", detail: String(localized: "\(store.drafts.count) drafts"), alert: false, route: .sent)
                card("Agents", icon: "wand.and.stars", detail: String(localized: "\(store.agents.count) agents"), alert: false, route: .agents)
            }
            .padding(.horizontal, 16).padding(.top, 14).padding(.bottom, 6)
        }
    }

    private func card(_ title: LocalizedStringKey, icon: String, detail: String, alert: Bool, route: ChatRoute) -> some View {
        Button { path.append(route) } label: {
            VStack(alignment: .leading, spacing: 8) {
                Image(systemName: icon).font(.system(size: 18, weight: .medium))
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(.subheadline.weight(.semibold)).lineLimit(1).minimumScaleFactor(0.7)
                    Text(verbatim: detail).font(.footnote)
                        .foregroundStyle(alert ? Theme.Colors.accent : Theme.Colors.textSecondary).lineLimit(1)
                }
            }
            .foregroundStyle(Theme.Colors.textPrimary)
            .padding(12)
            .frame(width: 112, alignment: .leading)
            .background(Theme.Colors.surfaceRaised, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(Theme.Colors.border, lineWidth: 1))
            .contentShape(RoundedRectangle(cornerRadius: 12))
        }
        .buttonStyle(PressFeedbackStyle())
        .accessibilityLabel(title)
        .accessibilityValue(Text(verbatim: detail))
    }

    private func collapsed(_ key: String) -> Bool { collapsedRaw.split(separator: "|").contains { $0 == key } }
    private func toggle(_ key: String) {
        var keys = Set(collapsedRaw.split(separator: "|").map(String.init))
        if keys.contains(key) { keys.remove(key) } else { keys.insert(key) }
        withAnimation(.easeOut(duration: 0.2)) { collapsedRaw = keys.sorted().joined(separator: "|") }
    }

    /// A section's name, tapped to fold it away, as Slack's are.
    private func sectionHeader(_ key: String, title: LocalizedStringKey) -> some View {
        sectionHeaderRow(key, label: Text(title), trailing: EmptyView())
    }
    private func sectionHeader<T: View>(_ key: String, title: LocalizedStringKey, @ViewBuilder trailing: () -> T) -> some View {
        sectionHeaderRow(key, label: Text(title), trailing: trailing())
    }
    private func sectionHeader<T: View>(_ key: String, verbatim: String, @ViewBuilder trailing: () -> T) -> some View {
        sectionHeaderRow(key, label: Text(verbatim: verbatim), trailing: trailing())
    }
    private func sectionHeaderRow<T: View>(_ key: String, label: Text, trailing: T) -> some View {
        let folded = collapsed(key)
        return HStack(spacing: 8) {
            Button { toggle(key) } label: {
                HStack(spacing: 6) {
                    label.font(.subheadline.weight(.semibold)).foregroundStyle(Theme.Colors.textPrimary)
                    Image(systemName: "chevron.down").font(.caption2.weight(.bold))
                        .foregroundStyle(Theme.Colors.textTertiary)
                        .rotationEffect(.degrees(folded ? -90 : 0))
                    Spacer(minLength: 0)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityValue(folded ? Text("Collapsed") : Text("Expanded"))
            trailing
        }
        .padding(.top, 14).padding(.bottom, 2)
        .listRowInsets(EdgeInsets(top: 0, leading: 20, bottom: 0, trailing: 20))
        .listRowSeparator(.hidden)
        .listRowBackground(Color.clear)
    }

    private func actionRow(_ title: LocalizedStringKey, icon: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Image(systemName: icon).font(.system(size: 14, weight: .semibold)).frame(width: 24)
                Text(title).font(.body)
                Spacer(minLength: 0)
            }
            .foregroundStyle(Theme.Colors.textSecondary)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .listRowInsets(EdgeInsets(top: 0, leading: 20, bottom: 0, trailing: 20))
        .listRowSeparator(.hidden)
        .listRowBackground(Color.clear)
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

    /// One conversation, as Slack's sidebar draws it: its mark, its name —
    /// bold while something is new — and a count of what named you.
    private func row(_ c: ChatConversation, large: Bool = false) -> some View {
        let fresh = store.isFresh(c.view)
        let mentions = store.mentions(in: c.view)
        let face: CGFloat = large ? 36 : 24
        return Button { path.append(.conversation(view: c.view, jump: nil)) } label: {
            HStack(spacing: 12) {
                if c.kind == .channel {
                    Image(systemName: c.isPrivate ? "lock" : "number").font(.system(size: 16, weight: fresh ? .bold : .regular))
                        .frame(width: face)
                        .accessibilityLabel(c.isPrivate ? Text("Private channel") : Text("Channel"))
                } else if c.kind == .agent {
                    ChatAvatar(name: c.name, size: face, agentEmoji: c.agent?.glyph ?? ChatAgent.glyph(nil), url: c.agent?.avatarUrl)
                } else if c.kind == .group {
                    Image(systemName: "person.2.fill").font(.system(size: large ? 15 : 11, weight: .semibold))
                        .foregroundStyle(Theme.Colors.textSecondary).frame(width: face, height: face)
                        .background(Theme.Colors.textTertiary.opacity(0.18), in: RoundedRectangle(cornerRadius: 7))
                } else {
                    ChatAvatar(name: c.name, size: face, url: c.member?.avatarUrl)
                        .overlay(alignment: .bottomTrailing) {
                            if ChatDates.parse(c.member?.awayUntil).map({ $0 > Date() }) == true {
                                Circle().stroke(Theme.Colors.textTertiary, lineWidth: 2).background(Circle().fill(Theme.Colors.surface))
                                    .frame(width: 9, height: 9).offset(x: 2, y: 2)
                            }
                        }
                }
                Text(c.name).font(.body.weight(fresh ? .semibold : .regular)).lineLimit(1)
                if let e = c.member?.status?.emoji, !e.isEmpty { Text(e).font(.subheadline) }
                Spacer(minLength: 4)
                if store.hasDraft(c.view) { Image(systemName: "pencil").font(.caption).foregroundStyle(Theme.Colors.textTertiary).accessibilityLabel("Draft") }
                if store.prefs[c.view] == "mute" { Image(systemName: "bell.slash").font(.caption).foregroundStyle(Theme.Colors.textTertiary).accessibilityLabel("Muted") }
                if mentions > 0 {
                    Text(verbatim: "\(mentions)").font(.caption.weight(.bold)).foregroundStyle(.white)
                        .padding(.horizontal, 7).padding(.vertical, 2).background(Theme.Colors.reject, in: Capsule())
                } else if fresh && large {
                    Circle().fill(Theme.Colors.interactive).frame(width: 8, height: 8).accessibilityLabel("Unread")
                }
            }
            .foregroundStyle(fresh ? Theme.Colors.textPrimary : Theme.Colors.textSecondary)
            .padding(.vertical, large ? 6 : 0)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .listRowInsets(EdgeInsets(top: 0, leading: 20, bottom: 0, trailing: 20))
        .listRowSeparator(.hidden)
        .listRowBackground(Color.clear)
        .contextMenu { rowMenu(c) }
    }

    /// Hold a conversation: what the web's right-click offers — a star, a
    /// section, how much it notifies you, its link, and for a channel its
    /// name, archiving it, or leaving a private one.
    @ViewBuilder
    private func rowMenu(_ c: ChatConversation) -> some View {
        let starred = store.isStarred(c.view)
        if store.isFresh(c.view) || store.mentions(in: c.view) > 0 {
            Button { Task { await store.markRead(c.view) } } label: { Label("Mark as read", systemImage: "checkmark.circle") }
            Divider()
        }
        Button { Task { await store.toggleStar(c.view) } } label: {
            Label(starred ? LocalizedStringKey("Unstar") : LocalizedStringKey("Star"), systemImage: starred ? "star.slash" : "star")
        }
        Menu {
            ForEach(store.sidebar.sections) { s in
                Button { Task { await store.move(c.view, to: s.id) } } label: {
                    if store.section(of: c.view)?.id == s.id { Label(s.name, systemImage: "checkmark") } else { Text(verbatim: s.name) }
                }
            }
            if store.section(of: c.view) != nil {
                Button("Back to where it was") { Task { await store.move(c.view, to: nil) } }
            }
        } label: { Label("Move to a section", systemImage: "folder") }
        .disabled(store.sidebar.sections.isEmpty)
        Menu {
            Picker("Notify me about", selection: Binding(get: { store.prefs[c.view] ?? "default" }, set: { v in Task { await store.setPref(c.view, level: v) } })) {
                Text("Mentions, replies and a sound for posts").tag("default")
                Text("Every post, on the phone too").tag("all")
                Text("Just mentions").tag("mentions")
                Text("Mute").tag("mute")
            }
        } label: { Label("Notify me about", systemImage: store.prefs[c.view] == "mute" ? "bell.slash" : "bell") }
        Button {
            Task { if let link = await store.conversationLink(c.view) { UIPasteboard.general.url = link } }
        } label: { Label("Copy link", systemImage: "link") }
        if c.kind == .channel {
            Divider()
            Button { renameTo = c.name; renaming = c } label: { Label("Rename channel…", systemImage: "pencil") }
            Button(role: .destructive) { archiving = c } label: { Label("Archive channel…", systemImage: "archivebox") }
            if c.isPrivate {
                Button(role: .destructive) { leaving = c } label: { Label("Leave channel", systemImage: "rectangle.portrait.and.arrow.right") }
            }
        }
    }
}

/// "Talk to an agent": every agent you can call, to open your own
/// conversation with it.
struct ChatAgentPickerSheet: View {
    let agents: [ChatAgent]
    let onPick: (ChatAgent) -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(agents) { a in
                        Button { onPick(a) } label: {
                            HStack(spacing: 12) {
                                ChatAvatar(name: a.name, size: 36, agentEmoji: a.glyph, url: a.avatarUrl)
                                VStack(alignment: .leading, spacing: 2) {
                                    HStack(spacing: 6) {
                                        Text(verbatim: a.name).font(.body.weight(.semibold)).foregroundStyle(Theme.Colors.textPrimary).lineLimit(1)
                                        Text(verbatim: "@\(a.handle)").font(.caption).foregroundStyle(Theme.Colors.textTertiary).lineLimit(1)
                                    }
                                    if let d = a.description, !d.isEmpty {
                                        Text(verbatim: d).font(.footnote).foregroundStyle(Theme.Colors.textSecondary).lineLimit(2)
                                    }
                                }
                                Spacer(minLength: 0)
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                } footer: {
                    Text("Only you see this conversation. Write anything and the agent answers there.")
                }
            }
            .navigationTitle("Talk to an agent")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }
}
