import Combine
import Foundation
import SwiftUI

/// One conversation in the list: a channel, a teammate, a group, or one of
/// the team's agents.
struct ChatConversation: Identifiable, Hashable {
    enum Kind: Hashable { case channel, person, group, agent }
    let kind: Kind
    /// `b:<slug>`, `dm:<ref>`, `g:<id>` or `ag:<agentId>` — what the Worker calls it for this person.
    let view: String
    let name: String
    var member: ChatMember?
    /// A channel only its members see.
    var isPrivate: Bool = false
    /// A group's people besides you.
    var refs: [String] = []
    /// Set for a conversation with one of the team's agents.
    var agent: ChatAgent? = nil
    var id: String { view }

    /// What the Worker calls your conversation with this agent.
    static func agentView(_ agentId: String) -> String { "ag:\(agentId)" }

    /// Your own conversation with an agent: only you see it, and whatever
    /// you write there the agent answers.
    static func forAgent(_ a: ChatAgent) -> ChatConversation {
        ChatConversation(kind: .agent, view: agentView(a.id), name: a.name, member: nil, agent: a)
    }

    /// Conversations in the order a person set; the rest keep theirs.
    static func inOrder(_ list: [ChatConversation], _ order: [String]) -> [ChatConversation] {
        let rank = Dictionary(order.enumerated().map { ($1, $0) }, uniquingKeysWith: { a, _ in a })
        return list.enumerated()
            .sorted { (rank[$0.element.view] ?? Int.max, $0.offset) < (rank[$1.element.view] ?? Int.max, $1.offset) }
            .map(\.element)
    }

    /// The agents you have talked with, the newest talk first.
    static func agentConversations(agents: [ChatAgent], activity: [String: ChatActivity]) -> [ChatConversation] {
        agents.filter { activity[agentView($0.id)] != nil }
            .map { forAgent($0) }
            .sorted { (activity[$0.view]?.lastAt ?? "") > (activity[$1.view]?.lastAt ?? "") }
    }
}

/// One of the team's agents writing its answer, and the thread it goes in.
struct ChatAgentTyping: Hashable {
    let agent: ChatAgentFace
    let parentId: String?
}

/// Everything the chat tab knows, kept current by the relay's channel events.
@MainActor
final class ChatStore: ObservableObject {
    @Published private(set) var members: [ChatMember] = []
    /// What a message needs from the workspace to be drawn: its emoji, the
    /// API's address, and everyone's photos.
    var assets: ChatAssets {
        let me = members.first { $0.mine }
        var avatars: [String: String] = [:]
        for m in members { if let a = m.avatarUrl, !a.isEmpty { avatars[m.ref] = a } }
        return ChatAssets(emoji: emoji, base: baseURL, avatars: avatars, myAvatar: me?.avatarUrl, myName: me?.name)
    }
    /// A member's photo, by ref.
    func avatar(of ref: String?) -> String? {
        guard let ref else { return nil }
        return members.first { $0.ref == ref }?.avatarUrl
    }
    @Published private(set) var businesses: [ChatBusiness] = []
    @Published private(set) var groups: [ChatGroup] = []
    /// This workspace's own emoji, by name. Only this workspace's.
    @Published private(set) var emoji: [ChatEmoji] = []
    /// Threads you are in, the newest reply first.
    @Published private(set) var threads: [ChatThreadItem] = []
    /// "@sales": the workspace's user groups, for the composer.
    @Published private(set) var userGroups: [ChatUserGroup] = []
    /// Your starred conversations and your own sections.
    @Published private(set) var sidebar = ChatSidebar()
    @Published private(set) var activity: [String: ChatActivity] = [:]
    @Published private(set) var reads: [String: String] = [:]
    @Published var prefs: [String: String] = [:]
    @Published private(set) var mine: ChatMine?
    @Published private(set) var messages: [String: [ChatMessage]] = [:]
    @Published private(set) var more: [String: Bool] = [:]
    @Published private(set) var inbox: [ChatActivityItem] = []
    @Published private(set) var saved: [ChatSaved] = []
    @Published private(set) var scheduled: [ChatScheduled] = []
    @Published var thinking: [String: String] = [:]
    /// "@hayao": the agents you can call here, the team's and your own.
    @Published private(set) var agents: [ChatAgent] = []
    /// Agents writing answers, by conversation, until each one has.
    @Published var agentTyping: [String: [ChatAgentTyping]] = [:]
    @Published var thread: ChatThread? {
        // The thread as it stands — replies sent, edited, arrived live —
        // kept for the next time it is opened (#209).
        didSet { if let t = thread, let key = viewKey(t.parent.id) { threadReplies[key] = t.replies.filter { !$0.id.hasPrefix("tmp-") } } }
    }
    @Published var error: String?
    /// What was last shown, in memory, for this account and workspace: a
    /// thread's replies and a teammate's profile, drawn at once when opened
    /// again and replaced by what the server says behind them.
    private var threadReplies: [String: [ChatMessage]] = [:]
    private var profiles: [String: (profile: ChatProfile, at: Date)] = [:]
    private func viewKey(_ id: String) -> String? {
        guard let orgId, let me = appState?.currentUser?.id else { return nil }
        return "\(me)|\(orgId)|\(id)"
    }

    private weak var appState: AppState?
    private var bag = Set<AnyCancellable>()
    private let page = 150

    init() {
        NotificationCenter.default.publisher(for: .chatMessageEvent)
            .receive(on: RunLoop.main)
            .sink { [weak self] note in self?.receiveMessage(note.object as? Data) }
            .store(in: &bag)
        NotificationCenter.default.publisher(for: .chatProgressEvent)
            .receive(on: RunLoop.main)
            .sink { [weak self] note in self?.receiveProgress(note.object as? Data) }
            .store(in: &bag)
        // Somebody joined or left: "@" and the people list know them now.
        NotificationCenter.default.publisher(for: .chatMembersChanged)
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in Task { await self?.refresh(); await self?.appState?.refreshWorkspaceMembers() } }
            .store(in: &bag)
        NotificationCenter.default.publisher(for: .chatReadsChanged)
            .receive(on: RunLoop.main)
            .sink { [weak self] note in self?.readElsewhere(note.userInfo ?? [:]) }
            .store(in: &bag)
    }

    /// Read on another device (or marked unread there): the same here, and
    /// the notifications this phone still shows for it come down.
    func readElsewhere(_ value: [AnyHashable: Any]) {
        if let items = value["items"] as? [String] {
            let keys = Set(items)
            inbox = inbox.map { var i = $0; if i.unread && keys.contains(i.id) { i.unread = false }; return i }
            let read = (value["threads"] as? [[String: Any]] ?? []).compactMap { t -> ChatService.ThreadRead? in
                guard let id = t["thread"] as? String, let at = t["lastReadAt"] as? String else { return nil }
                return ChatService.ThreadRead(thread: id, lastReadAt: at)
            }
            threadsRead(read)
            PushService.clearDelivered(messageIds: Self.messageIds(items))
            return
        }
        guard let view = value["view"] as? String, let at = value["lastReadAt"] as? String else { return }
        // An app looked at elsewhere (Automations on the web): its cards stop
        // counting on this phone's icon too.
        if view.hasPrefix("app:") { AppReads.shared.merge([view: at]); return }
        let unread = value["unread"] as? Bool == true
        if let parentId = value["thread"] as? String {
            if unread { Task { await loadThreads() }; return }
            if let i = threads.firstIndex(where: { $0.parent.id == parentId }) { threads[i].unread = false }
            inbox = inbox.map { var i = $0; if i.unread && ((i.message.parentId == parentId && i.message.createdAt <= at) || (i.message.id == parentId && i.type != "reaction")) { i.unread = false }; return i }
            PushService.clearDelivered(channel: view, parentId: parentId, orgId: orgId)
            return
        }
        if unread { reads[view] = at; return }
        if at > (reads[view] ?? "") { reads[view] = at }
        inbox = inbox.map { var i = $0; if i.unread && i.message.channel == view && i.message.parentId == nil && i.message.createdAt <= at { i.unread = false }; return i }
        PushService.clearDelivered(channel: view, parentId: nil, orgId: orgId)
    }

    func bind(_ appState: AppState) { self.appState = appState }

    private var orgId: String? { appState?.currentUser?.teamID }
    private var base: URL? { appState?.backendBaseURL }
    var myRef: String? { members.first { $0.mine }?.ref }

    // MARK: The list

    /// In the order the person dragged them into (on the web); the rest
    /// follow in the team's order.
    var channels: [ChatConversation] {
        let list = businesses.map { ChatConversation(kind: .channel, view: "b:\($0.slug)", name: $0.name, member: nil, isPrivate: $0.isPrivate == true) }
        return ChatConversation.inOrder(list, sidebar.order ?? [])
    }
    /// Group DMs, named by their people, newest talk first.
    var groupConversations: [ChatConversation] {
        groups.map { g in
            let names = g.refs.map { ref in members.first { $0.ref == ref }?.name ?? String(localized: "a teammate") }
            return ChatConversation(kind: .group, view: g.view, name: ListFormatter.localizedString(byJoining: names), member: nil, refs: g.refs)
        }
        .sorted { (activity[$0.view]?.lastAt ?? "") > (activity[$1.view]?.lastAt ?? "") }
    }
    func emojiURL(_ name: String) -> URL? {
        let bare = name.trimmingCharacters(in: CharacterSet(charactersIn: ":"))
        guard let e = emoji.first(where: { $0.name == bare }) else { return nil }
        return URL(string: e.url)
    }
    var baseURL: URL? { base }

    /// A link to one message, the same the web copies: it opens where the
    /// message is, for whoever can read it, in the workspace it was said in.
    func messageLink(_ m: ChatMessage) async -> URL? {
        guard let base, let web = await ChatJamLink.webURL(base: base) else { return nil }
        return Self.messageLink(web: web, messageId: m.id, orgId: orgId)
    }
    nonisolated static func messageLink(web: URL, messageId: String, orgId: String?) -> URL? {
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_."))
        guard let id = messageId.addingPercentEncoding(withAllowedCharacters: allowed) else { return nil }
        let org = orgId.flatMap { $0.addingPercentEncoding(withAllowedCharacters: allowed) }.map { "/\($0)" } ?? ""
        return URL(string: "\(web.absoluteString)/#/m/\(id)\(org)")
    }
    var people: [ChatConversation] {
        members.filter { !$0.mine }.map { ChatConversation(kind: .person, view: "dm:\($0.ref)", name: $0.name, member: $0) }
            .sorted { (activity[$0.view]?.lastAt ?? "") > (activity[$1.view]?.lastAt ?? "") }
    }
    /// Conversations with agents that have something in them, newest first.
    var agentConversations: [ChatConversation] {
        ChatConversation.agentConversations(agents: agents, activity: activity)
    }
    func conversation(for view: String) -> ChatConversation? {
        if view.hasPrefix("ag:") {
            let id = String(view.dropFirst(3))
            return agents.first { $0.id == id }.map { ChatConversation.forAgent($0) }
        }
        return (channels + people + groupConversations).first { $0.view == view }
    }

    /// Said since you last read, and not muted.
    func isFresh(_ view: String) -> Bool {
        guard prefs[view] == nil, let a = activity[view], a.lastBy != "me" else { return false }
        return a.lastAt > (reads[view] ?? "")
    }
    var unreadInbox: Int { inbox.filter(\.unread).count }
    /// Direct and group conversations with something new, for the DMs tab.
    var unreadDMs: Int { (people + groupConversations).filter { isFresh($0.view) }.count }
    func mentions(in view: String) -> Int { inbox.filter { $0.unread && $0.type == "mention" && $0.message.channel == view }.count }
    func nameOf(ref: String) -> String {
        if ref == myRef { return String(localized: "You") }
        return members.first { $0.ref == ref }?.name ?? String(localized: "a teammate")
    }

    func refresh() async {
        guard let orgId, let base else { return }
        do {
            async let o = ChatService.overview(orgId: orgId, base: base)
            async let b = ChatService.businesses(orgId: orgId, base: base)
            let (overview, list) = try await (o, b)
            members = overview.members
            activity = Dictionary(uniqueKeysWithValues: overview.activity.map { ($0.channel, $0) })
            reads = overview.reads ?? [:]
            AppReads.shared.merge(reads)
            prefs = overview.prefs ?? [:]
            mine = overview.mine
            groups = overview.groups ?? []
            agents = overview.agents ?? []
            businesses = list
        } catch { self.error = error.localizedDescription }
        if let list = try? await ChatService.emoji(orgId: orgId, base: base) { emoji = list } else { emoji = [] }
        if let list = try? await ChatService.userGroups(orgId: orgId, base: base) { userGroups = list } else { userGroups = [] }
        ChatMentionDirectory.shared.update(members: members, groups: userGroups, agents: agents)
        if let layout = try? await ChatService.sidebar(orgId: orgId, base: base) { sidebar = layout } else { sidebar = ChatSidebar() }
        await loadThreads()
        async let i: Void = loadInbox()
        async let l: Void = loadLater()
        async let s: Void = loadScheduled()
        _ = await (i, l, s)
    }

    /// The agents as `/channels/agents` last returned them, after a change
    /// made on the Agents screen: the composer offers them at once.
    func setAgents(_ list: [ChatAgent]) {
        // `/channels/agents` lists only your own; the ones others added to
        // your channels stay until the next overview says otherwise.
        let ids = Set(list.map(\.id))
        agents = list + agents.filter { $0.placed == true && !ids.contains($0.id) }
        ChatMentionDirectory.shared.update(members: members, groups: userGroups, agents: agents)
    }

    /// "@" suggestions for agents in one conversation: handle, then what the
    /// chip says. One somebody added to a channel is offered only there.
    func agentMentions(in view: String) -> [(handle: String, label: String, emoji: String, avatarUrl: String?)] {
        agents.filter { $0.placed != true || ($0.channels ?? []).contains(view) }
            .map { (handle: $0.handle, label: $0.name, emoji: $0.glyph, avatarUrl: $0.avatarUrl) }
    }

    /// The agents in a channel or a group, and the ones you could add.
    func channelAgents(_ view: String) async -> ChatService.ChannelAgents? {
        guard let orgId, let base else { return nil }
        return try? await ChatService.channelAgents(orgId: orgId, channel: view, base: base)
    }

    /// Bring an agent in, or take it out. Nil when it worked, else why not.
    func placeAgent(_ agentId: String, in view: String, add: Bool) async -> String? {
        guard let orgId, let base else { return String(localized: "That did not save.") }
        do {
            try await ChatService.placeAgent(orgId: orgId, channel: view, agentId: agentId, add: add, base: base)
            await refresh()
            return nil
        } catch {
            return (error as? LocalizedError)?.errorDescription ?? String(localized: "That did not save.")
        }
    }

    func loadThreads() async {
        guard let orgId, let base else { return }
        if let list = try? await ChatService.threads(orgId: orgId, base: base) { threads = list }
    }
    var unreadThreads: Int { threads.filter(\.unread).count }
    func markThreadRead(_ item: ChatThreadItem) async {
        guard let orgId, let base else { return }
        if let i = threads.firstIndex(where: { $0.id == item.id }) { threads[i].unread = false }
        // Its replies in Activity are read too, and its first message where it named you.
        inbox = inbox.map { var i = $0; if i.unread && (i.message.parentId == item.parent.id || (i.message.id == item.parent.id && i.type != "reaction")) { i.unread = false }; return i }
        await ChatService.markThreadRead(orgId: orgId, channel: item.parent.channel, parentId: item.parent.id, base: base)
    }

    // MARK: Your sidebar

    func isStarred(_ view: String) -> Bool { sidebar.starred.contains(view) }
    func section(of view: String) -> ChatSidebar.Section? { sidebar.sections.first { $0.views.contains(view) } }
    /// Not starred and in none of your sections: where it always was.
    func isUnplaced(_ view: String) -> Bool { !isStarred(view) && section(of: view) == nil }
    func toggleStar(_ view: String) async {
        var next = sidebar
        if next.starred.contains(view) { next.starred.removeAll { $0 == view } } else { next.starred.append(view) }
        await saveSidebar(next)
    }
    func move(_ view: String, to sectionId: String?) async {
        var next = sidebar
        for i in next.sections.indices {
            next.sections[i].views.removeAll { $0 == view }
            if next.sections[i].id == sectionId { next.sections[i].views.append(view) }
        }
        await saveSidebar(next)
    }
    func newSection(_ name: String, with view: String?) async {
        var next = sidebar
        if let view { for i in next.sections.indices { next.sections[i].views.removeAll { $0 == view } } }
        next.sections.append(ChatSidebar.Section(id: String(UUID().uuidString.prefix(8)).lowercased(), name: name, views: view.map { [$0] } ?? []))
        await saveSidebar(next)
    }
    func removeSection(_ id: String) async {
        var next = sidebar
        next.sections.removeAll { $0.id == id }
        await saveSidebar(next)
    }
    private func saveSidebar(_ next: ChatSidebar) async {
        guard let orgId, let base else { return }
        sidebar = next
        do { sidebar = try await ChatService.saveSidebar(orgId: orgId, sidebar: next, base: base) }
        catch { self.error = error.localizedDescription }
    }

    // MARK: Unread, forward

    /// Unread from this message on, on every device.
    func markUnread(_ m: ChatMessage) async {
        guard let orgId, let base else { return }
        do {
            let out = try await ChatService.markUnread(orgId: orgId, channel: m.channel, messageId: m.id, base: base)
            if out.thread != nil { await loadThreads() } else { reads[m.channel] = out.lastReadAt }
            Haptics.light()
        } catch { self.error = error.localizedDescription }
    }

    /// Forward into another conversation. From a DM, a group or a private
    /// channel only a link goes; whoever can read the original opens it.
    func isClosed(_ view: String) -> Bool {
        view.hasPrefix("dm:") || view.hasPrefix("g:") || view.hasPrefix("ag:") || (conversation(for: view)?.isPrivate ?? false)
    }
    func forward(_ m: ChatMessage, to target: String, comment: String, webLink: String?) async -> Bool {
        let link = webLink ?? ""
        let body: String
        if isClosed(m.channel) {
            body = [comment, link].filter { !$0.isEmpty }.joined(separator: "\n")
        } else {
            let quoted = m.body.isEmpty ? "> 📎" : m.body.prefix(600).split(separator: "\n", omittingEmptySubsequences: false).map { "> \($0)" }.joined(separator: "\n")
            let from = conversation(for: m.channel)
            let who = m.isAI ? String(localized: "Your AI") : (m.authorName ?? String(localized: "a teammate"))
            let whereFrom = from.map { $0.kind == .channel ? ", #\($0.name)" : "" } ?? ""
            body = [comment, quoted, "— \(who)\(whereFrom)", link].filter { !$0.isEmpty }.joined(separator: "\n")
        }
        return await send(target, text: body)
    }

    func loadInbox() async {
        guard let orgId, let base else { return }
        if let items = try? await ChatService.activity(orgId: orgId, base: base) { inbox = items }
    }
    func loadLater() async {
        guard let orgId, let base else { return }
        if let items = try? await ChatService.later(orgId: orgId, base: base) { saved = items }
    }
    func loadScheduled() async {
        guard let orgId, let base else { return }
        if let items = try? await ChatService.scheduled(orgId: orgId, base: base) { scheduled = items }
    }

    // MARK: A conversation

    func open(_ view: String) async {
        guard let orgId, let base else { return }
        do {
            let list = try await ChatService.messages(orgId: orgId, channel: view, base: base)
            messages[view] = list
            more[view] = list.count >= page
        } catch { self.error = error.localizedDescription }
        await markRead(view)
        await translate(view, messages[view] ?? [])
    }

    /// Messages in another language, put into this reader's (translate.js).
    func translate(_ channel: String, _ list: [ChatMessage]) async {
        guard let orgId, let base else { return }
        let reader = String((appState?.readerLanguageCode ?? "en").prefix(2)).lowercased()
        let tr = ChatTranslations.shared
        // This account's, in this workspace: what was kept on the phone
        // comes back before anything is asked for (#225).
        if let me = appState?.currentUser?.id { tr.use(scope: "\(me)|\(orgId)") }
        let want = tr.wanted(list, reader: reader)
        guard !want.isEmpty else { return }
        let asked = Array(want.prefix(60))
        tr.retry = { [weak self] m in Task { await self?.translate(m.channel, [m]) } }
        tr.asking(asked)
        let got: ChatService.Translations
        do {
            got = try await ChatService.translate(orgId: orgId, channel: channel, ids: asked.map(\.id), locale: reader, base: base)
        } catch {
            tr.answered(asked, error: ChatTranslateFailure.of(error))
            return
        }
        if got.off == true { tr.off = true; tr.answered(asked, error: nil, reasons: [:]); return }
        for m in asked { if let text = got.translations[m.id] { tr.store(m.id, from: m.body, text: text, lang: reader) } }
        tr.answered(asked, error: nil, reasons: got.failed ?? [:])
    }

    func markRead(_ view: String) async {
        guard let orgId, let base else { return }
        reads[view] = ChatDates.string(.now)
        // Read here, so no longer new in Activity (a reply waits for its thread).
        inbox = inbox.map { var i = $0; if i.unread && i.message.channel == view && i.message.parentId == nil { i.unread = false }; return i }
        PushService.clearDelivered(channel: view, parentId: nil, orgId: orgId)
        await ChatService.markRead(orgId: orgId, channel: view, base: base)
    }

    /// A conversation's latest messages without reading it: Catch up shows
    /// them, and only a swipe to the right marks the conversation read.
    func peek(_ view: String) async -> [ChatMessage] {
        guard let orgId, let base else { return [] }
        let list = (try? await ChatService.messages(orgId: orgId, channel: view, base: base)) ?? []
        await translate(view, list)
        return list
    }
    /// When this person last read a conversation, as the server keeps it.
    func readAt(_ view: String) -> String? { reads[view] }

    /// Every conversation with something new, or an @ waiting for you.
    var freshViews: [String] {
        (channels + groupConversations + people + agentConversations).map(\.view)
            .filter { isFresh($0) || mentions(in: $0) > 0 }
    }
    /// Everything new, read at once — Slack's Mark all as read: those
    /// conversations, and Activity with them.
    func markEverythingRead() async {
        for view in freshViews { await markRead(view) }
        if unreadInbox > 0 { await markAllInboxRead() }
    }

    /// Activity items looked at: read here at once, and everywhere else.
    func seenInbox(_ ids: [String]) async {
        guard let orgId, let base else { return }
        let keys = Set(ids)
        guard inbox.contains(where: { $0.unread && keys.contains($0.id) }) else { return }
        inbox = inbox.map { var i = $0; if i.unread && keys.contains(i.id) { i.unread = false }; return i }
        let server = ids.filter { $0.hasPrefix("m:") || $0.hasPrefix("r:") }
        PushService.clearDelivered(messageIds: Self.messageIds(server))
        // A reply looked at here is read in its thread too: Threads agrees.
        if !server.isEmpty { threadsRead(await ChatService.markActivitySeen(orgId: orgId, items: server, base: base)) }
    }

    nonisolated static func messageIds(_ keys: [String]) -> [String] {
        keys.filter { $0.hasPrefix("m:") }.map { String($0.dropFirst(2)) }
    }

    /// Activity's "Mark all as read": everything new there, and the threads
    /// its replies are in.
    func markAllInboxRead() async {
        guard let orgId, let base else { return }
        let keys = inbox.filter(\.unread).map(\.id)
        guard !keys.isEmpty else { return }
        inbox = inbox.map { var i = $0; i.unread = false; return i }
        PushService.clearDelivered(messageIds: Self.messageIds(keys))
        if let done = await ChatService.markAllActivityRead(orgId: orgId, base: base) { threadsRead(done.threads) } else { await loadInbox() }
    }

    /// Threads' "Mark all as read": each thread read up to its newest reply,
    /// and those replies in Activity too.
    func markAllThreadsRead() async {
        guard let orgId, let base else { return }
        let open = threads.filter(\.unread)
        guard !open.isEmpty else { return }
        threadsRead(open.map { ChatService.ThreadRead(thread: $0.parent.id, lastReadAt: $0.lastReplyAt) })
        for t in open { PushService.clearDelivered(channel: t.parent.channel, parentId: t.parent.id, orgId: orgId) }
        if await ChatService.markAllThreadsRead(orgId: orgId, base: base) == nil { await loadThreads() }
    }

    /// Threads read up to a point, wherever that was done: each one whose
    /// newest reply is no later is no longer new.
    func threadsRead(_ read: [ChatService.ThreadRead]) {
        guard !read.isEmpty else { return }
        threads = Self.readThrough(threads, read)
        // Their replies, no later than that, are read in Activity too.
        let upTo = Dictionary(read.map { ($0.thread, $0.lastReadAt) }, uniquingKeysWith: { a, b in max(a, b) })
        inbox = inbox.map { var i = $0; if i.unread, let p = i.message.parentId, let at = upTo[p], (i.at ?? i.message.createdAt) <= at { i.unread = false }; return i }
    }

    nonisolated static func readThrough(_ threads: [ChatThreadItem], _ read: [ChatService.ThreadRead]) -> [ChatThreadItem] {
        let upTo = Dictionary(read.map { ($0.thread, $0.lastReadAt) }, uniquingKeysWith: { a, b in max(a, b) })
        return threads.map { var t = $0; if t.unread, let at = upTo[t.parent.id], t.lastReplyAt <= at { t.unread = false }; return t }
    }

    func loadOlder(_ view: String) async {
        guard more[view] == true, let first = messages[view]?.first, let orgId, let base else { return }
        more[view] = false
        guard let older = try? await ChatService.messages(orgId: orgId, channel: view, before: first.createdAt, base: base) else { return }
        let known = Set((messages[view] ?? []).map(\.id))
        messages[view] = older.filter { !known.contains($0.id) } + (messages[view] ?? [])
        more[view] = older.count >= page
    }

    /// A message one of the workspace's data rules warned about, held while
    /// the person decides whether to send it anyway.
    struct DataRuleWarning: Identifiable {
        let id = UUID()
        let view: String
        let text: String
        let decide: Bool
        let parentId: String?
        var alsoChannel = false
        var clientId: String? = nil
        let at: Date?
        let files: [ChatFile]
        let rules: [String]
    }
    @Published var dataWarning: DataRuleWarning?
    /// Why a message could not be sent at all: a data rule that blocks.
    @Published var dataBlocked: String?

    /// What a message on its way was sent with, to send it again (#212).
    private struct HeldSend { let view: String; let text: String; let decide: Bool; let parentId: String?; let alsoChannel: Bool; let files: [ChatFile] }
    private var heldSends: [String: HeldSend] = [:]

    /// Whether a send that did not go is kept in the conversation, failed,
    /// to send again — so its words need not come back to the box.
    func isHeld(_ clientId: String) -> Bool {
        if case .failed = ChatSends.shared.states[clientId] { return true }
        return false
    }

    /// Yours, drawn the moment it is sent: faded, under the send's own id,
    /// until the server's copy takes its place.
    private func drawSending(_ clientId: String, view: String, text: String, parentId: String?, alsoChannel: Bool, files: [ChatFile]) {
        let sends = ChatSends.shared
        sends.states[clientId] = .pending
        sends.retry = { [weak self] id in Task { await self?.sendAgain(id) } }
        sends.discard = { [weak self] id in self?.throwAway(id) }
        let me = members.first { $0.mine }
        let m = ChatMessage(id: clientId, channel: view, kind: "message", body: text, authorName: me?.name, authorRef: me?.ref, mine: true,
                            createdAt: ISO8601DateFormatter().string(from: Date()), parentId: parentId, files: files.isEmpty ? nil : files,
                            alsoChannel: parentId != nil && alsoChannel ? true : nil)
        if let parentId, thread?.parent.id == parentId, !(thread?.replies.contains { $0.id == clientId } ?? false) { thread?.replies.append(m) }
        if parentId == nil || alsoChannel, messages[view] != nil, !(messages[view]?.contains { $0.id == clientId } ?? false) { messages[view]?.append(m) }
    }

    /// The server has it: its copy where ours was, and up to full opacity.
    private func landed(_ clientId: String, as m: ChatMessage) {
        ChatSends.shared.states[clientId] = nil
        heldSends[clientId] = nil
        var copy = m
        copy.mine = true
        if let i = thread?.replies.firstIndex(where: { $0.id == clientId }) {
            if thread?.replies.contains(where: { $0.id == m.id }) == true { thread?.replies.remove(at: i) } else { thread?.replies[i] = copy }
        }
        if var list = messages[m.channel], let i = list.firstIndex(where: { $0.id == clientId }) {
            if list.contains(where: { $0.id == m.id }) { list.remove(at: i) } else { list[i] = copy }
            messages[m.channel] = list
        }
        upsert(m)
        ChatSends.shared.landed(m.id)
    }

    private func takeBack(_ clientId: String) {
        ChatSends.shared.states[clientId] = nil
        heldSends[clientId] = nil
        thread?.replies.removeAll { $0.id == clientId }
        for (k, list) in messages where list.contains(where: { $0.id == clientId }) { messages[k] = list.filter { $0.id != clientId } }
    }

    /// A failed one, sent again under the same id: a send that in fact
    /// landed comes back as the message already posted.
    func sendAgain(_ clientId: String) async {
        guard let h = heldSends[clientId] else { return }
        _ = await send(h.view, text: h.text, decide: h.decide, parentId: h.parentId, alsoChannel: h.alsoChannel, files: h.files, clientId: clientId)
    }
    /// A failed one, thrown away.
    func throwAway(_ clientId: String) { if isHeld(clientId) { takeBack(clientId) } }

    @discardableResult
    func send(_ view: String, text: String, decide: Bool = false, parentId: String? = nil, alsoChannel: Bool = false, at: Date? = nil, files: [ChatFile] = [], acknowledged: Bool = false, clientId: String? = nil) async -> Bool {
        guard let orgId, let base else { return false }
        // A scheduled one is not in the conversation until its time.
        let drawn = at == nil ? clientId : nil
        if let drawn {
            heldSends[drawn] = HeldSend(view: view, text: text, decide: decide, parentId: parentId, alsoChannel: alsoChannel, files: files)
            drawSending(drawn, view: view, text: text, parentId: parentId, alsoChannel: alsoChannel, files: files)
        }
        do {
            let sent = try await ChatService.send(orgId: orgId, channel: view, body: text, decide: decide, parentId: parentId, alsoChannel: alsoChannel, sendAt: at, files: files.map(\.id), acknowledged: acknowledged, clientId: clientId, base: base)
            if let s = sent.scheduled { scheduled.append(s); scheduled.sort { $0.sendAt < $1.sendAt } }
            if let m = sent.message { if let drawn { landed(drawn, as: m) } else { upsert(m) } } else if let drawn { takeBack(drawn) }
            if sent.deciding == true { thinking[view] = "reading" }
            Haptics.success()
            return true
        } catch ChatService.Failure.dataRule(let blocked, let rules, _) {
            if let drawn { takeBack(drawn) }
            let what = rules.map { NSLocalizedString($0, comment: "") }.joined(separator: ", ")
            if blocked {
                dataBlocked = String(localized: "This can't be sent here: it looks like it contains \(what). Take it out and try again.")
            } else {
                dataWarning = DataRuleWarning(view: view, text: text, decide: decide, parentId: parentId, alsoChannel: alsoChannel, clientId: clientId, at: at, files: files, rules: rules)
            }
            return false
        } catch {
            // Not reached — the network, the server, too busy — it stays in
            // the conversation, failed, to send again. Refused outright (the
            // sign-in, the words), it is taken back and its words return to
            // the box.
            let reached: Bool
            switch error {
            case ChatService.Failure.server(let status, _): reached = status >= 400 && status < 500 && status != 408 && status != 429
            case ChatService.Failure.notSignedIn: reached = true
            default: reached = false
            }
            if let drawn {
                if reached { takeBack(drawn) } else { ChatSends.shared.states[drawn] = .failed(error.localizedDescription) }
            }
            if reached || drawn == nil { self.error = error.localizedDescription }
            return false
        }
    }

    /// The warned-about message, sent after all.
    func sendAnyway(_ w: DataRuleWarning) async -> Bool {
        dataWarning = nil
        return await send(w.view, text: w.text, decide: w.decide, parentId: w.parentId, alsoChannel: w.alsoChannel, at: w.at, files: w.files, acknowledged: true, clientId: w.clientId)
    }

    /// A picture or a file for the message about to be sent, uploaded now.
    func upload(_ view: String, data: Data, type: String, name: String, width: Int? = nil, height: Int? = nil) async -> ChatFile? {
        guard let orgId, let base else { return nil }
        do { return try await ChatService.upload(orgId: orgId, channel: view, data: data, type: type, name: name, width: width, height: height, base: base) }
        catch { self.error = error.localizedDescription; return nil }
    }

    /// A conversation with several people: the same people, the same one.
    func startGroup(_ refs: [String]) async -> String? {
        guard let orgId, let base else { return nil }
        do {
            let view = try await ChatService.startGroup(orgId: orgId, refs: refs, base: base)
            if view.hasPrefix("g:"), !groups.contains(where: { $0.view == view }) { groups.append(ChatGroup(view: view, refs: refs)) }
            return view
        } catch { self.error = error.localizedDescription; return nil }
    }

    func edit(_ m: ChatMessage, to text: String) async {
        guard let orgId, let base else { return }
        do { if let out = try await ChatService.edit(orgId: orgId, channel: m.channel, messageId: m.id, body: text, base: base) { upsert(out) } }
        catch { self.error = error.localizedDescription }
    }
    func delete(_ m: ChatMessage) async {
        guard let orgId, let base else { return }
        do { if let out = try await ChatService.delete(orgId: orgId, channel: m.channel, messageId: m.id, base: base) { upsert(out) } }
        catch { self.error = error.localizedDescription }
    }
    func react(_ m: ChatMessage, _ emoji: String) async {
        guard let orgId, let base else { return }
        Haptics.light()
        do { if let out = try await ChatService.react(orgId: orgId, channel: m.channel, messageId: m.id, emoji: emoji, base: base) { upsert(out) } }
        catch { self.error = error.localizedDescription }
    }
    /// Take the link cards off your own message, for everyone.
    func hidePreviews(_ m: ChatMessage) async {
        guard let orgId, let base else { return }
        do { if let out = try await ChatService.hidePreviews(orgId: orgId, channel: m.channel, messageId: m.id, base: base) { upsert(out) } }
        catch { self.error = error.localizedDescription }
    }
    func togglePin(_ m: ChatMessage) async {
        guard let orgId, let base else { return }
        do { if let out = try await ChatService.pin(orgId: orgId, channel: m.channel, messageId: m.id, pinned: m.pinned != true, base: base) { upsert(out) } }
        catch { self.error = error.localizedDescription }
    }
    func decide(_ m: ChatMessage) async {
        guard let orgId, let base else { return }
        do { try await ChatService.decide(orgId: orgId, channel: m.channel, messageId: m.id, base: base); thinking[m.channel] = "reading" }
        catch { self.error = error.localizedDescription }
    }
    func saveForLater(_ m: ChatMessage, remindAt: Date?) async {
        guard let orgId, let base else { return }
        do { try await ChatService.saveForLater(orgId: orgId, channel: m.channel, messageId: m.id, remindAt: remindAt, base: base); Haptics.success(); await loadLater() }
        catch { self.error = error.localizedDescription }
    }
    func finishLater(_ item: ChatSaved) async {
        guard let orgId, let base else { return }
        saved.removeAll { $0.id == item.id }
        try? await ChatService.finishLater(orgId: orgId, id: item.id, base: base)
    }
    func cancelScheduled(_ s: ChatScheduled) async {
        guard let orgId, let base else { return }
        scheduled.removeAll { $0.id == s.id }
        try? await ChatService.cancelScheduled(orgId: orgId, id: s.id, base: base)
    }
    func setPref(_ view: String, level: String) async {
        guard let orgId, let base else { return }
        if level == "all" { prefs[view] = nil } else { prefs[view] = level }
        try? await ChatService.setPref(orgId: orgId, channel: view, level: level, base: base)
    }
    func openThread(_ m: ChatMessage) async {
        guard let orgId, let base else { return }
        // A reply shown in the conversation opens the thread it is in.
        if let parentId = m.parentId {
            if let head = messages[m.channel]?.first(where: { $0.id == parentId }) { return await openThread(head) }
            guard let t = try? await ChatService.thread(orgId: orgId, channel: m.channel, messageId: parentId, base: base) else { return }
            return await openThread(t.parent)
        }
        thread = ChatThread(parent: m, replies: viewKey(m.id).flatMap { threadReplies[$0] } ?? [])
        if let t = try? await ChatService.thread(orgId: orgId, channel: m.channel, messageId: m.id, base: base), thread?.parent.id == m.id { thread = t }
        if let t = thread { await translate(m.channel, [t.parent] + t.replies) }
        // A thread opened is a thread read: Threads and Activity both stop
        // calling its replies new.
        inbox = inbox.map { var i = $0; if i.unread && i.message.parentId == m.id { i.unread = false }; return i }
        if let i = threads.firstIndex(where: { $0.parent.id == m.id }) { threads[i].unread = false }
        PushService.clearDelivered(channel: m.channel, parentId: m.id, orgId: orgId)
        await ChatService.markThreadRead(orgId: orgId, channel: m.channel, parentId: m.id, base: base)
    }
    func pins(_ view: String) async -> [ChatMessage] {
        guard let orgId, let base else { return [] }
        return (try? await ChatService.pins(orgId: orgId, channel: view, base: base)) ?? []
    }
    func search(_ query: String) async -> [ChatMessage] {
        guard let orgId, let base, query.trimmingCharacters(in: .whitespaces).count >= 2 else { return [] }
        return (try? await ChatService.search(orgId: orgId, query: query, base: base)) ?? []
    }
    /// Rename a channel (`b:<slug>`); nil when done, else what went wrong.
    func renameChannel(_ view: String, to name: String) async -> String? {
        guard let orgId, let base, view.hasPrefix("b:") else { return String(localized: "That did not save.") }
        do {
            businesses = try await ChatService.renameChannel(orgId: orgId, slug: String(view.dropFirst(2)), name: name, base: base)
            return nil
        } catch { return error.localizedDescription }
    }
    /// Leave a private channel; nil when done, else what went wrong.
    func leaveChannel(_ view: String) async -> String? {
        guard let orgId, let base else { return String(localized: "That did not work. Try again.") }
        do {
            try await ChatService.leaveChannel(orgId: orgId, channel: view, base: base)
            await refresh()
            return nil
        } catch { return error.localizedDescription }
    }
    /// Archive a channel; nil when done, else what went wrong.
    func archiveChannel(_ view: String) async -> String? {
        guard let orgId, let base, view.hasPrefix("b:") else { return String(localized: "That did not work. Try again.") }
        do {
            businesses = try await ChatService.archiveChannel(orgId: orgId, slug: String(view.dropFirst(2)), base: base)
            await refresh()
            return nil
        } catch { return error.localizedDescription }
    }
    func archivedChannels() async -> [ChatService.ArchivedChannel] {
        guard let orgId, let base else { return [] }
        return (try? await ChatService.archivedChannels(orgId: orgId, base: base)) ?? []
    }
    /// Bring an archived channel back; nil when done, else what went wrong.
    func unarchiveChannel(_ slug: String) async -> String? {
        guard let orgId, let base else { return String(localized: "That did not work. Try again.") }
        do {
            businesses = try await ChatService.unarchiveChannel(orgId: orgId, slug: slug, base: base)
            await refresh()
            return nil
        } catch { return error.localizedDescription }
    }
    /// The web app's address for a conversation, as the web copies it.
    func conversationLink(_ view: String) async -> URL? {
        guard let base, let web = await ChatJamLink.webURL(base: base) else { return nil }
        return Self.conversationLink(web: web, view: view)
    }
    nonisolated static func conversationLink(web: URL, view: String) -> URL? {
        // encodeURIComponent's set: ASCII letters and digits only, so a
        // channel named in Japanese ("b:日報") is percent-encoded as the web does.
        let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()")
        guard let encoded = view.addingPercentEncoding(withAllowedCharacters: allowed) else { return nil }
        return URL(string: "\(web.absoluteString)/#/c/\(encoded)")
    }

    func createChannel(_ name: String) async {
        guard let orgId, let base else { return }
        do { businesses = try await ChatService.createChannel(orgId: orgId, name: name, base: base) }
        catch { self.error = error.localizedDescription }
    }
    func clip(_ view: String, items: [ChatMessage], instruction: String) async -> Bool {
        guard let orgId, let base else { return false }
        do {
            let out = try await ChatService.clip(orgId: orgId, channel: view, items: items.map { ($0.channel, $0.id) }, instruction: instruction, base: base)
            if let m = out.message { upsert(m) }
            thinking[view] = "reading"
            return true
        } catch { self.error = error.localizedDescription; return false }
    }
    /// A profile read before, to draw at once.
    func cachedProfile(_ ref: String) -> ChatProfile? {
        viewKey("profile:" + ref).flatMap { profiles[$0]?.profile }
    }
    /// The profile from the server — or, read within the last half minute,
    /// the one already here.
    func profile(_ ref: String) async -> ChatProfile? {
        guard let orgId, let base else { return nil }
        let key = viewKey("profile:" + ref)
        if let key, let kept = profiles[key], Date().timeIntervalSince(kept.at) < 30 { return kept.profile }
        guard let fresh = try? await ChatService.profile(orgId: orgId, ref: ref, base: base) else { return nil }
        if let key { profiles[key] = (fresh, Date()) }
        return fresh
    }

    /// A slash command: done here, with a line only you see.
    func command(_ view: String, name: String, rest: String) async -> String? {
        guard let orgId, let base else { return nil }
        switch name {
        case "remember":
            guard !rest.isEmpty else { return String(localized: "Write the rule after /remember.") }
            do { try await ChatService.remember(orgId: orgId, text: rest, base: base); return String(localized: "Added to the playbook: “\(rest)”") }
            catch { return error.localizedDescription }
        case "routine":
            guard !rest.isEmpty else { return String(localized: "Say what and when after /routine — e.g. every Monday at 9 summarise last week.") }
            do {
                let when = try await ChatService.routine(orgId: orgId, text: rest, locale: appState?.readerLanguageCode ?? "en", base: base)
                return String(localized: "Your AI will do this \(when).")
            } catch { return error.localizedDescription }
        default:
            return String(localized: "/\(name) is not a command. Try /decide, /remember, /routine or /schedule.")
        }
    }

    // MARK: Live

    /// A changed or new message, wherever it shows.
    func upsert(_ incoming: ChatMessage) {
        var m = incoming
        if let myRef {
            if m.authorRef == myRef { m.mine = true }
            m.reactions = m.reactions?.map { var r = $0; r.mine = r.refs.contains(myRef); return r }
        }
        // Ours, brought by the socket before the answer to the send: in the
        // place of the copy on its way, not beside it.
        if m.mine, !m.id.hasPrefix("tmp-"), let held = heldSends.first(where: { id, h in
            h.view == m.channel && h.text == m.body && h.parentId == m.parentId && ChatSends.shared.states[id] == .pending
        })?.key, !(messages[m.channel]?.contains { $0.id == m.id } ?? false), !(thread?.replies.contains { $0.id == m.id } ?? false) {
            return landed(held, as: m)
        }
        if let parent = m.parentId {
            if thread?.parent.id == parent {
                if m.isDeleted { thread?.replies.removeAll { $0.id == m.id } }
                else if let i = thread?.replies.firstIndex(where: { $0.id == m.id }) { thread?.replies[i] = m }
                else { thread?.replies.append(m) }
            }
            // Sent to the conversation too: there as well.
            guard m.alsoChannel == true else { return }
        }
        var list = messages[m.channel] ?? []
        if let i = list.firstIndex(where: { $0.id == m.id }) {
            // Deleted is gone, its thread with it — never a "was deleted" line.
            if m.isDeleted { list.remove(at: i) } else { list[i] = m }
        } else if !m.isDeleted {
            list.append(m)
            if !m.mine { activity[m.channel] = ChatActivity(channel: m.channel, lastAt: m.createdAt, preview: String(m.body.prefix(120)), lastBy: m.authorName) }
        }
        if messages[m.channel] != nil { messages[m.channel] = list }
        if thread?.parent.id == m.id {
            if m.isDeleted { thread = nil } else { thread?.parent = m }
        }
    }

    private func receiveMessage(_ data: Data?) {
        struct Envelope: Decodable { let message: ChatMessage }
        guard let data, let m = try? JSONDecoder().decode(Envelope.self, from: data).message else { return }
        upsert(m)
        Task { await translate(m.channel, [m]) }
        if m.isAI { thinking[m.channel] = nil }
        if m.isAgent, let id = m.agent?.id {
            var list = agentTyping[m.channel] ?? []
            list.removeAll { $0.agent.id == id }
            agentTyping[m.channel] = list.isEmpty ? nil : list
        }
        // Somebody started a group with you: it joins the list.
        if m.channel.hasPrefix("g:"), !groups.contains(where: { $0.view == m.channel }) { Task { await refresh() } }
        if !m.mine && (m.parentId != nil || m.body.contains("@") || m.body.contains("＠")) {
            Task { await loadInbox() }
        }
    }

    private func receiveProgress(_ data: Data?) {
        guard let data, let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let channel = json["channel"] as? String, let step = json["step"] as? String else { return }
        // One of the team's agents, not @AI: its own line, not the card steps.
        if let a = json["agent"] as? [String: Any], let id = a["id"] as? String {
            var list = agentTyping[channel] ?? []
            list.removeAll { $0.agent.id == id }
            if step != "done" && step != "failed" {
                let face = ChatAgentFace(id: id, handle: a["handle"] as? String ?? "", name: a["name"] as? String ?? "", emoji: a["emoji"] as? String)
                list.append(ChatAgentTyping(agent: face, parentId: json["parentId"] as? String))
            }
            agentTyping[channel] = list.isEmpty ? nil : list
            return
        }
        thinking[channel] = (step == "done" || step == "failed") ? nil : step
    }

    // MARK: Drafts, per conversation, on this device

    func draft(_ view: String) -> String { UserDefaults.standard.string(forKey: "chat.draft.\(orgId ?? "").\(view)") ?? "" }
    func setDraft(_ view: String, _ text: String) {
        let key = "chat.draft.\(orgId ?? "").\(view)"
        if text.isEmpty { UserDefaults.standard.removeObject(forKey: key) } else { UserDefaults.standard.set(text, forKey: key) }
    }
    func hasDraft(_ view: String) -> Bool { !draft(view).isEmpty }
    /// Every conversation with something still being written in it.
    struct Draft: Identifiable {
        let conversation: ChatConversation
        let text: String
        var id: String { conversation.view }
    }
    var drafts: [Draft] {
        (channels + groupConversations + people + agentConversations).compactMap { c in
            let text = draft(c.view)
            return text.isEmpty ? nil : Draft(conversation: c, text: text)
        }
    }
    /// What you said, newest first.
    func loadSent() async -> [ChatMessage] {
        guard let orgId, let base else { return [] }
        return (try? await ChatService.sent(orgId: orgId, base: base)) ?? []
    }
}
