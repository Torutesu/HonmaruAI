#!/usr/bin/env python3
"""Exercise actual native chat control flow with in-memory services on macOS.

This extracts unchanged Swift declarations/methods; it does not build the iOS app,
use a session/keychain, or make network calls. UIKit/SwiftUI rendering still needs
simulator/device acceptance. Run: python3 scripts/test-native-chat.py
"""
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
service = (ROOT / 'TikTokForWork/Services/ChatService.swift').read_text()
store = (ROOT / 'TikTokForWork/Features/Chat/ChatStore.swift').read_text()


def between(source, start, end):
    return source[source.index(start):source.index(end, source.index(start))]


models = between(service, 'struct ChatReaction:', 'struct ChatMemberStatus:')
models += between(service, 'struct ChatThreadItem:', '/// A user group:')
models += between(service, 'struct ChatThread:', 'struct ChatScheduled:')
models += between(store, 'struct ChatOutbox {', '/// Everything the chat tab knows')

methods = between(store, '    private var threadReads:', '    var unreadThreads:')
methods += between(store, '    func open(_ view:', '    /// Messages in another language')
methods += between(store, '    func markRead(_ view:', '    /// A conversation\'s latest messages')
methods += between(store, '    private func heldMessage(', '    /// The server has it: its copy')
methods += between(store, '    /// Bound before picker', '    /// A conversation with several')
methods += between(store, '    private struct ReactionChange', '    /// Take the link cards')
methods += between(store, '    /// One navigation owns', '    func pins(')
methods += between(store, '    /// A changed or new message', '    private func receiveMessage(')
# No production declaration is edited except access control for test fixtures.
methods = methods.replace('private ', '')

stubs = r'''
struct ChatAgentFace: Codable, Hashable {}
struct ChatDates {
    static func parse(_ value: String) -> Date? { ISO8601DateFormatter().date(from: value) }
    static func string(_ value: Date) -> String { ISO8601DateFormatter().string(from: value) }
}
struct User { var id = "alice"; var teamID = "A" }
struct AppState { var currentUser: User? = User() }
struct Member { let ref: String; let mine: Bool; let name: String }
struct ActivityItem { var message: ChatMessage; var unread: Bool }
struct ChatActivity { let channel: String; let lastAt: String; let preview: String; let lastBy: String? }
struct Warning { var view: String; var replyTo: ChatQuote? }
@MainActor enum SessionStore { static var sessionToken: String? = "synthetic-account-A" }
@MainActor enum Haptics { static func light() {} }
@MainActor final class ChatSends {
    enum State: Equatable { case pending; case failed(String) }
    static let shared = ChatSends()
    var states: [String: State] = [:]
}
@MainActor enum PushService {
    static var cutoffs: [Date?] = []
    static func clearDelivered(channel: String, parentId: String?, orgId: String?, readUpTo: Date? = nil) { cutoffs.append(readUpTo) }
}
@MainActor final class Gate<T> {
    var continuations: [CheckedContinuation<T, Error>] = []
    var calls = 0
    func wait() async throws -> T { calls += 1; return try await withCheckedThrowingContinuation { continuations.append($0) } }
    func resolve(_ value: T) { continuations.removeFirst().resume(returning: value) }
    func resolveAll(_ value: T) { while !continuations.isEmpty { resolve(value) } }
    func reject(_ error: Error) { continuations.removeFirst().resume(throwing: error) }
}
@MainActor enum ChatService {
    enum Failure: Error { case notSignedIn; case server(Int, String?) }
    static var getThread: ((String, String, String) async throws -> ChatThread)!
    static var getPage: ((String?) async throws -> ChatThread)?
    static var getReference: ((String) async throws -> ChatMessage)!
    static var getMessages: ((String) async throws -> [ChatMessage]) = { _ in [] }
    static var postReaction: ((String) async throws -> ChatMessage?)!
    static var postUpload: ((String, String) async throws -> ChatFile)!
    static var readWait: (() async -> Void)?
    static var readPositions: [String] = []
    static func thread(orgId: String, channel: String, messageId: String, before: String? = nil, base: URL) async throws -> ChatThread {
        if let getPage { return try await getPage(before) }
        return try await getThread(orgId, channel, messageId)
    }
    static func threadReference(orgId: String, channel: String, parentId: String, messageId: String, base: URL) async throws -> ChatMessage { try await getReference(messageId) }
    static func messages(orgId: String, channel: String, base: URL) async throws -> [ChatMessage] { try await getMessages(channel) }
    static func react(orgId: String, channel: String, messageId: String, emoji: String, base: URL) async throws -> ChatMessage? { try await postReaction(emoji) }
    static func upload(orgId: String, channel: String, data: Data, type: String, name: String, width: Int?, height: Int?, base: URL, token: String) async throws -> ChatFile { try await postUpload(orgId, token) }
    static func markThreadRead(orgId: String, channel: String, parentId: String, at: String? = nil, base: URL) async { readPositions.append(at!); await readWait?() }
    static func markRead(orgId: String, channel: String, base: URL) async { await readWait?() }
}
@MainActor final class ChatStore {
    var appState: AppState? = AppState()
    var orgId: String? { appState?.currentUser?.teamID }
    var base: URL? = URL(string: "https://synthetic.invalid")!
    var scope = "alice|A"
    var scopeGeneration = UUID()
    var members = [Member(ref: "me", mine: true, name: "Reader")]
    var myRef: String? { members.first { $0.mine }?.ref }
    var messages: [String: [ChatMessage]] = [:]
    var threadCache: [String: ChatThread] = [:]
    var threads: [ChatThreadItem] = []
    var thread: ChatThread? { didSet { if let t = thread, let key = viewKey(t.parent.id) { var cached = t; cached.replies = t.replies.filter { !$0.id.hasPrefix("tmp-") }; threadCache[key] = cached } } }
    var threadLoading = false
    var threadFailed = false
    var threadOlderLoading = false
    var threadOlderFailed = false
    var threadReferenceId: String?
    var threadReferenceLoading = false
    var threadReferenceFailed = false
    var threadReference: ChatMessage?
    var referenceNavigation = UUID()
    var threadReadTo: [String: String] = [:]
    var threadJump: String?
    var error: String?
    var activity: [String: ChatActivity] = [:]
    var inbox: [ActivityItem] = []
    var reads: [String: String] = [:]
    var more: [String: Bool] = [:]
    var olderFailed: Set<String> = []
    var heldSends: [String: ChatOutbox.Entry] = [:]
    var dataWarning: Warning?
    let page = 150
    var translationWait: (() async -> Void)?
    func translate(_ channel: String, _ messages: [ChatMessage]) async { await translationWait?() }
    func viewKey(_ id: String) -> String? { "\(scope)|\(id)" }
    func landed(_ id: String, as message: ChatMessage) { heldSends[id] = nil; upsert(message) }
    static func withoutReplies(of id: String, in messages: [ChatMessage]) -> [ChatMessage] { messages.filter { $0.parentId != id } }
'''

checks = r'''
}
@main struct Checks {
    @MainActor static func message(_ id: String, _ body: String = "hello", parent: String? = nil) -> ChatMessage {
        ChatMessage(id: id, channel: "b:general", kind: "message", body: body, mine: false, createdAt: "2026-10-01T09:00:00Z", parentId: parent)
    }
    static func check(_ value: Bool, _ message: String = "") { precondition(value, message) }
    @MainActor static func drain() async { for _ in 0..<30 { await Task.yield() } }
    @MainActor static func main() async throws {
        // One missing-root read; neither channel acknowledgment nor translation blocks it.
        let store = ChatStore(), gate = Gate<ChatThread>(), translation = Gate<Void>(), read = Gate<Void>()
        store.translationWait = { try? await translation.wait() }
        ChatService.readWait = { try? await read.wait() }
        let parent = message("root"), reply = message("reply", parent: "root")
        ChatService.getThread = { _, _, _ in try await gate.wait() }
        let navigation = Task { await store.openThread(channel: "b:general", parentId: "root") }
        await drain(); check(store.threadLoading && store.thread == nil && gate.calls == 1)
        gate.resolve(ChatThread(parent: parent, replies: [reply]))
        check(await navigation.value); check(store.thread?.replies.count == 1)
        check(ChatService.readPositions.isEmpty, "A fetch must not mark hidden content read")
        await store.open("b:general"); await drain()
        check(read.calls == 1 && translation.calls >= 1, "Background work may remain pending after content is ready")
        read.resolve(()); translation.resolveAll(()); store.translationWait = nil
        // Close keeps pending reads from reopening the sheet.
        let closingGate = Gate<ChatThread>()
        ChatService.getThread = { _, _, _ in try await closingGate.wait() }
        let closing = Task { await store.openThread(channel: "b:general", parentId: "closed") }
        await drain(); store.closeThread(); closingGate.resolve(ChatThread(parent: message("closed"), replies: []))
        check(!(await closing.value)); check(store.thread == nil)
        // Prefetch/navigation overlap shares one read; held/live replies survive.
        store.translationWait = nil; ChatService.readWait = nil
        let shared = Gate<ChatThread>()
        ChatService.getThread = { _, _, _ in try await shared.wait() }
        let prefetch = Task { await store.readThread(channel: "b:general", parentId: "shared") }
        await drain()
        let showing = Task { await store.openThread(channel: "b:general", parentId: "shared") }
        await drain(); check(shared.calls == 1)
        let live = message("live", parent: "shared")
        store.upsert(live)
        shared.resolve(ChatThread(parent: message("shared"), replies: []))
        _ = await prefetch.value; check(await showing.value)
        check(store.thread?.replies.map(\.id) == ["live"])
        // A finishing after B cannot clear B's loading state or install A.
        let a = Gate<ChatThread>(), b = Gate<ChatThread>()
        ChatService.getThread = { _, _, id in try await (id == "A" ? a : b).wait() }
        let navA = Task { await store.openThread(channel: "b:general", parentId: "A") }; await drain()
        let navB = Task { await store.openThread(channel: "b:general", parentId: "B") }; await drain()
        a.resolve(ChatThread(parent: message("A"), replies: [])); check(!(await navA.value)); check(store.threadLoading)
        b.resolve(ChatThread(parent: message("B"), replies: [reply])); check(await navB.value); check(store.thread?.parent.id == "B")
        // Scope generation rejects a result even after switching away and back.
        let old = Gate<ChatThread>()
        ChatService.getThread = { _, _, _ in try await old.wait() }
        let stale = Task { await store.openThread(channel: "b:general", parentId: "old") }; await drain()
        store.scopeGeneration = UUID(); store.closeThread()
        old.resolve(ChatThread(parent: message("old"), replies: [])); check(!(await stale.value)); check(store.thread == nil)
        // Quotes update in channels, open/cached threads, pending outbox and composer references.
        var original = message("original", "old words"), quoted = message("quoted")
        quoted.replyTo = ChatQuote(of: original)
        var unrelated = message("unrelated"); unrelated.replyTo = ChatQuote(of: message("other", "keep"))
        store.messages["b:general"] = [quoted, unrelated]
        store.thread = ChatThread(parent: parent, replies: [quoted])
        store.threads = [ChatThreadItem(parent: parent, replies: [quoted], replyCount: 1, lastReplyAt: reply.createdAt, unread: true)]
        store.heldSends["tmp-q"] = ChatOutbox.Entry(clientId: "tmp-q", user: "alice", orgId: "A", view: "b:general", text: "held", decide: false, parentId: nil, alsoChannel: false, files: [], replyTo: ChatQuote(of: original), createdAt: reply.createdAt, reason: nil)
        original.body = "corrected"; store.upsert(original)
        check(store.messages["b:general"]![0].replyTo?.excerpt == "corrected")
        check(store.thread!.replies[0].replyTo?.excerpt == "corrected")
        check(store.threadCache.values.flatMap { $0.replies }.first { $0.id == "quoted" }?.replyTo?.excerpt == "corrected")
        original.deleted = true; store.upsert(original)
        check(store.messages["b:general"]![0].replyTo?.deleted == true && store.messages["b:general"]![0].replyTo?.excerpt == "")
        check(store.threads[0].replies[0].replyTo?.deleted == true)
        check(store.heldSends["tmp-q"]?.replyTo?.deleted == true)
        check(store.quote(of: original).excerpt == "")
        check(store.messages["b:general"]![1].replyTo?.excerpt == "keep")
        // Reaction feedback precedes the response; duplicate taps do not toggle twice.
        let reactions = ChatStore(), r1 = Gate<ChatMessage?>(), r2 = Gate<ChatMessage?>()
        var target = message("reaction")
        reactions.messages[target.channel] = [target]
        reactions.thread = ChatThread(parent: target, replies: [])
        ChatService.postReaction = { emoji in try await (emoji == "👍" ? r1 : r2).wait() }
        let first = Task { [target] in await reactions.react(target, "👍") }; await drain()
        check(reactions.messages[target.channel]![0].reactions?.first?.mine == true)
        check(reactions.thread?.parent.reactions?.first?.status == "pending")
        await reactions.react(target, "👍"); check(r1.calls == 1)
        let second = Task { [target] in await reactions.react(target, "❤️") }; await drain()
        // Another participant arrives while both requests are pending.
        target.reactions = [ChatReaction(emoji: "👍", count: 1, refs: ["other"], mine: false)]
        reactions.upsert(target)
        r2.resolve(target); await second.value; r1.resolve(target); await first.value
        let settled = reactions.messages[target.channel]![0]
        check(settled.reactions?.first { $0.emoji == "👍" }?.count == 2)
        check(settled.reactions?.first { $0.emoji == "👍" }?.refs.contains("other") == true)
        check(settled.reactions?.first { $0.emoji == "❤️" }?.mine == true)
        check(settled.reactions?.allSatisfy { $0.status == nil } == true)
        // Definite rejection rolls back only our bit and exposes retry.
        let rejection = Gate<ChatMessage?>()
        ChatService.postReaction = { _ in try await rejection.wait() }
        let rejected = Task { await reactions.react(target, "👍") }; await drain()
        rejection.reject(ChatService.Failure.server(400, nil)); await rejected.value
        check(reactions.messages[target.channel]![0].reactions?.first { $0.emoji == "👍" }?.mine == true)
        check(reactions.messages[target.channel]![0].reactions?.first { $0.emoji == "👍" }?.status == "failed")
        // A timeout reconciles a committed toggle without issuing a second POST.
        let timeout = Gate<ChatMessage?>()
        var posts = 0
        ChatService.postReaction = { _ in posts += 1; return try await timeout.wait() }
        var committed = message("timeout"); committed.reactions = [ChatReaction(emoji: "👍", count: 1, refs: ["me"], mine: true)]
        ChatService.getThread = { _, _, _ in ChatThread(parent: committed, replies: []) }
        reactions.messages["b:general"]!.append(message("timeout"))
        let timingOut = Task { await reactions.react(message("timeout"), "👍") }; await drain()
        timeout.reject(URLError(.timedOut)); await timingOut.value
        check(posts == 1 && reactions.messages["b:general"]!.last!.reactions?.first?.mine == true)
        check(reactions.messages["b:general"]!.last!.reactions?.first?.status == nil)
        // Delayed preparation cannot upload using a new workspace/account/token.
        let media = ChatStore(), file = ChatFile(id: "synthetic-file", name: "photo.jpg", type: "image/jpeg", size: 1, width: 1, height: 1, url: "/synthetic")
        let origin = media.mediaScope("b:general")!
        var destinations: [String] = []
        let upload = Gate<ChatFile>()
        ChatService.postUpload = { org, token in destinations.append("\(org)|\(token)"); return try await upload.wait() }
        media.appState?.currentUser?.teamID = "B"; media.scopeGeneration = UUID(); SessionStore.sessionToken = "synthetic-account-B"
        let forbidden = await media.upload(origin, data: Data([1]), type: "image/jpeg", name: "photo.jpg")
        check(forbidden == nil && destinations.isEmpty)
        media.appState?.currentUser?.teamID = "A"; media.scopeGeneration = UUID(); SessionStore.sessionToken = "synthetic-account-A"
        check(!media.isCurrent(origin), "A -> B -> A must invalidate preparation")
        let active = media.mediaScope("b:general")!
        let uploading = Task { await media.upload(active, data: Data([1]), type: "image/jpeg", name: "photo.jpg") }; await drain()
        check(destinations == ["A|synthetic-account-A"])
        media.appState?.currentUser?.id = "bob"; media.scopeGeneration = UUID(); SessionStore.sessionToken = "synthetic-account-B"
        upload.resolve(file); check(await uploading.value == nil, "A delayed result cannot attach in the next account")
        // Mark only displayed timestamps, retaining a newer cached unread reply.
        ChatService.readPositions = []; ChatService.readWait = nil
        let reads = ChatStore(); reads.thread = ChatThread(parent: parent, replies: [reply])
        var newer = reply; newer.createdAt = "2026-10-02T09:00:00Z"
        reads.inbox = [ActivityItem(message: newer, unread: true)]
        await reads.readOpenThread()
        check(ChatService.readPositions == [reply.createdAt] && reads.inbox[0].unread)
        check(PushService.cutoffs.last! == ChatDates.parse(reply.createdAt))
        // Bounded pages keep loaded history, live arrivals and failed sends.
        let pages = ChatStore(), olderGate = Gate<ChatThread>()
        let pageRoot = message("page-root")
        let latest = (0..<50).map { message("page-\($0)", parent: "page-root") }
        var cursors: [String?] = []
        ChatService.getPage = { cursor in
            cursors.append(cursor)
            if cursor != nil { return try await olderGate.wait() }
            return ChatThread(parent: pageRoot, replies: latest, more: true, nextCursor: "opaque-first")
        }
        pages.heldSends["tmp-page"] = ChatOutbox.Entry(clientId: "tmp-page", user: "alice", orgId: "A", view: "b:general", text: "held", decide: false, parentId: "page-root", alsoChannel: false, files: [], replyTo: nil, createdAt: reply.createdAt, reason: "offline")
        check(await pages.openThread(channel: "b:general", parentId: "page-root"))
        check(pages.thread!.replies.count == 51 && pages.thread!.hasOlder)
        let earlier = Task { await pages.loadOlderThread() }; await drain()
        check(cursors.count == 2 && cursors[1] == "opaque-first")
        var arriving = message("page-live", parent: "page-root"); arriving.createdAt = "2026-10-02T09:00:00Z"
        pages.upsert(arriving)
        var oldReply = message("old-page", parent: "page-root"); oldReply.createdAt = "2026-09-01T09:00:00Z"
        var staleDuplicate = latest[0]; staleDuplicate.body = "stale duplicate"
        olderGate.resolve(ChatThread(parent: pageRoot, replies: [oldReply, staleDuplicate], more: false))
        await earlier.value
        check(pages.thread!.replies.count == 53 && !pages.thread!.hasOlder)
        check(pages.thread!.replies.first!.id == "old-page")
        check(pages.thread!.replies.first { $0.id == latest[0].id }?.body == "hello")
        check(pages.thread!.replies.contains { $0.id == "tmp-page" })
        // Revalidation cannot discard earlier loaded pages or reset their cursor.
        check(await pages.openThread(channel: "b:general", parentId: "page-root"))
        check(pages.thread!.replies.count == 53 && !pages.thread!.hasOlder)
        check(pages.threadCache.values.first!.replies.count == 52, "Only confirmed replies enter the cache")
        // Legacy backend replies decode as complete; pagination metadata is optional.
        let legacyData = try JSONEncoder().encode(ChatThread(parent: pageRoot, replies: latest))
        let legacy = try JSONDecoder().decode(ChatThread.self, from: legacyData)
        check(!legacy.hasOlder && legacy.nextCursor == nil)
        let pageData = try JSONEncoder().encode(ChatThread(parent: pageRoot, replies: latest, more: true, nextCursor: "opaque-next"))
        check(try JSONDecoder().decode(ChatThread.self, from: pageData).nextCursor == "opaque-next")
        // An unloaded linked reply gets one bounded context lookup, never an older-page walk.
        let context = ChatStore(), contextGate = Gate<ChatMessage>()
        var contextCalls = 0, pageCalls = 0
        ChatService.getPage = { cursor in
            check(cursor == nil); pageCalls += 1
            return ChatThread(parent: pageRoot, replies: latest, more: true, nextCursor: "opaque-first")
        }
        ChatService.getReference = { id in check(id == "linked-old"); contextCalls += 1; return try await contextGate.wait() }
        context.threadJump = "linked-old"
        check(await context.openThread(channel: "b:general", parentId: "page-root")); await drain()
        check(pageCalls == 1 && contextCalls == 1 && context.threadReferenceLoading)
        let linked = message("linked-old", "current authorized words", parent: "page-root")
        let previousReads = ChatService.readPositions.count
        contextGate.resolve(linked); await drain()
        check(context.threadReference?.body == "current authorized words")
        check(context.thread!.replies.count == 50 && !context.thread!.replies.contains { $0.id == "linked-old" })
        check(ChatService.readPositions.count == previousReads, "Context lookup cannot mark newer replies read")
        let staleContext = Gate<ChatMessage>()
        ChatService.getReference = { _ in try await staleContext.wait() }
        let obsolete = Task { await context.loadThreadReference("linked-old") }; await drain()
        context.closeThread(); staleContext.resolve(linked); await obsolete.value
        check(context.threadReference == nil && !context.threadReferenceLoading)
        ChatService.getPage = nil
        print("Native chat regressions passed: linked reads/races, quotes/outbox, optimistic reactions/reconciliation, media scope, displayed read cutoff, bounded pages/cache/reference context.")
    }
}
'''

with tempfile.TemporaryDirectory(prefix='honmaru-native-chat-') as directory:
    path = Path(directory)
    (path / 'main.swift').write_text('import Foundation\n' + models + stubs + methods + checks)
    subprocess.run(['swiftc', '-swift-version', '5', '-parse-as-library', str(path / 'main.swift'), '-o', str(path / 'checks')], check=True)
    subprocess.run([str(path / 'checks')], check=True)
