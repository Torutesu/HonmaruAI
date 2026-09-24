import Combine
import Foundation
import SwiftUI

/// One conversation in the list: a channel, a teammate, or your AI.
struct ChatConversation: Identifiable, Hashable {
    enum Kind: Hashable { case channel, person }
    let kind: Kind
    /// `b:<slug>` or `dm:<ref>` — what the Worker calls it for this person.
    let view: String
    let name: String
    var member: ChatMember?
    var id: String { view }
}

/// Everything the chat tab knows, kept current by the relay's channel events.
@MainActor
final class ChatStore: ObservableObject {
    @Published private(set) var members: [ChatMember] = []
    @Published private(set) var businesses: [ChatBusiness] = []
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
    @Published var thread: ChatThread?
    @Published var error: String?

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
    }

    func bind(_ appState: AppState) { self.appState = appState }

    private var orgId: String? { appState?.currentUser?.teamID }
    private var base: URL? { appState?.backendBaseURL }
    var myRef: String? { members.first { $0.mine }?.ref }

    // MARK: The list

    var channels: [ChatConversation] {
        businesses.map { ChatConversation(kind: .channel, view: "b:\($0.slug)", name: $0.name, member: nil) }
    }
    var people: [ChatConversation] {
        members.filter { !$0.mine }.map { ChatConversation(kind: .person, view: "dm:\($0.ref)", name: $0.name, member: $0) }
            .sorted { (activity[$0.view]?.lastAt ?? "") > (activity[$1.view]?.lastAt ?? "") }
    }
    func conversation(for view: String) -> ChatConversation? { (channels + people).first { $0.view == view } }

    /// Said since you last read, and not muted.
    func isFresh(_ view: String) -> Bool {
        guard prefs[view] == nil, let a = activity[view], a.lastBy != "me" else { return false }
        return a.lastAt > (reads[view] ?? "")
    }
    var unreadInbox: Int { inbox.filter(\.unread).count }
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
            prefs = overview.prefs ?? [:]
            mine = overview.mine
            businesses = list
        } catch { self.error = error.localizedDescription }
        async let i: Void = loadInbox()
        async let l: Void = loadLater()
        async let s: Void = loadScheduled()
        _ = await (i, l, s)
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
    }

    func markRead(_ view: String) async {
        guard let orgId, let base else { return }
        reads[view] = ChatDates.string(.now)
        await ChatService.markRead(orgId: orgId, channel: view, base: base)
    }

    func markInboxRead() async {
        guard let orgId, let base else { return }
        await ChatService.markRead(orgId: orgId, channel: "activity", base: base)
        inbox = inbox.map { var i = $0; i.unread = false; return i }
    }

    func loadOlder(_ view: String) async {
        guard more[view] == true, let first = messages[view]?.first, let orgId, let base else { return }
        more[view] = false
        guard let older = try? await ChatService.messages(orgId: orgId, channel: view, before: first.createdAt, base: base) else { return }
        let known = Set((messages[view] ?? []).map(\.id))
        messages[view] = older.filter { !known.contains($0.id) } + (messages[view] ?? [])
        more[view] = older.count >= page
    }

    @discardableResult
    func send(_ view: String, text: String, decide: Bool = false, parentId: String? = nil, at: Date? = nil) async -> Bool {
        guard let orgId, let base else { return false }
        do {
            let sent = try await ChatService.send(orgId: orgId, channel: view, body: text, decide: decide, parentId: parentId, sendAt: at, base: base)
            if let s = sent.scheduled { scheduled.append(s); scheduled.sort { $0.sendAt < $1.sendAt } }
            if let m = sent.message { upsert(m) }
            if sent.deciding == true { thinking[view] = "reading" }
            Haptics.success()
            return true
        } catch { self.error = error.localizedDescription; return false }
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
        thread = ChatThread(parent: m, replies: [])
        if let t = try? await ChatService.thread(orgId: orgId, channel: m.channel, messageId: m.id, base: base), thread?.parent.id == m.id { thread = t }
    }
    func pins(_ view: String) async -> [ChatMessage] {
        guard let orgId, let base else { return [] }
        return (try? await ChatService.pins(orgId: orgId, channel: view, base: base)) ?? []
    }
    func search(_ query: String) async -> [ChatMessage] {
        guard let orgId, let base, query.trimmingCharacters(in: .whitespaces).count >= 2 else { return [] }
        return (try? await ChatService.search(orgId: orgId, query: query, base: base)) ?? []
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
    func profile(_ ref: String) async -> ChatProfile? {
        guard let orgId, let base else { return nil }
        return try? await ChatService.profile(orgId: orgId, ref: ref, base: base)
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
        if let parent = m.parentId {
            if thread?.parent.id == parent {
                if m.isDeleted { thread?.replies.removeAll { $0.id == m.id } }
                else if let i = thread?.replies.firstIndex(where: { $0.id == m.id }) { thread?.replies[i] = m }
                else { thread?.replies.append(m) }
            }
            return
        }
        var list = messages[m.channel] ?? []
        if let i = list.firstIndex(where: { $0.id == m.id }) {
            if m.isDeleted && (m.replyCount ?? 0) == 0 { list.remove(at: i) } else { list[i] = m }
        } else if !m.isDeleted {
            list.append(m)
            if !m.mine { activity[m.channel] = ChatActivity(channel: m.channel, lastAt: m.createdAt, preview: String(m.body.prefix(120)), lastBy: m.authorName) }
        }
        if messages[m.channel] != nil { messages[m.channel] = list }
        if thread?.parent.id == m.id { thread?.parent = m }
    }

    private func receiveMessage(_ data: Data?) {
        struct Envelope: Decodable { let message: ChatMessage }
        guard let data, let m = try? JSONDecoder().decode(Envelope.self, from: data).message else { return }
        upsert(m)
        if m.isAI { thinking[m.channel] = nil }
        if !m.mine && (m.parentId != nil || m.body.contains("@") || m.body.contains("＠")) {
            Task { await loadInbox() }
        }
    }

    private func receiveProgress(_ data: Data?) {
        guard let data, let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let channel = json["channel"] as? String, let step = json["step"] as? String else { return }
        thinking[channel] = (step == "done" || step == "failed") ? nil : step
    }

    // MARK: Drafts, per conversation, on this device

    func draft(_ view: String) -> String { UserDefaults.standard.string(forKey: "chat.draft.\(orgId ?? "").\(view)") ?? "" }
    func setDraft(_ view: String, _ text: String) {
        let key = "chat.draft.\(orgId ?? "").\(view)"
        if text.isEmpty { UserDefaults.standard.removeObject(forKey: key) } else { UserDefaults.standard.set(text, forKey: key) }
    }
    func hasDraft(_ view: String) -> Bool { !draft(view).isEmpty }
}
