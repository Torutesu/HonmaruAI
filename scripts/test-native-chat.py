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

methods = between(store, '    private struct ThreadRange', '    /// The open thread\'s replies') + between(store, '    private struct ThreadRead', '    var unreadThreads:')
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
        check(pages.thread!.replies.count == 52 && !pages.thread!.hasOlder)
        check(pages.threadCache.values.first!.replies.count == 51, "Only confirmed replies enter the cache")
        // Reconnect must bridge >50 missed replies before restoring cached cursors.
        func numbered(_ value: Int) -> ChatMessage {
            // Every reply shares one timestamp: only real ID overlap proves continuity.
            message(String(format: "n%03d", value), parent: "gap-root")
        }
        let gapRoot = message("gap-root")
        let reconnect = ChatStore(), bridgeGate = Gate<ChatThread>()
        reconnect.thread = ChatThread(parent: gapRoot, replies: (1...50).map(numbered), more: false)
        reconnect.recordThreadRange(reconnect.thread!, serverOrder: reconnect.thread!.replies.map(\.id))
        reconnect.closeThread()
        var gapRequests: [String?] = []
        ChatService.getPage = { cursor in
            gapRequests.append(cursor)
            switch cursor {
            case nil: return ChatThread(parent: gapRoot, replies: (101...150).map(numbered), more: true, nextCursor: "before-101")
            case "before-101": return try await bridgeGate.wait()
            case "before-51": return ChatThread(parent: gapRoot, replies: (1...50).map(numbered), more: false)
            default: preconditionFailure("Unexpected gap cursor")
            }
        }
        let catchingUp = Task { await reconnect.openThread(channel: "b:general", parentId: "gap-root") }; await drain()
        check(reconnect.threadLoading && reconnect.thread!.replies.count == 50)
        // An edit of an old cached ID is a live overlay, not overlap from a server page.
        var editedOld = numbered(1); editedOld.body = "edited while gap pending"
        reconnect.upsert(editedOld)
        var newLive = numbered(151); newLive.createdAt = "2026-10-02T09:00:00Z"
        reconnect.upsert(newLive)
        reconnect.heldSends["tmp-gap"] = ChatOutbox.Entry(clientId: "tmp-gap", user: "alice", orgId: "A", view: "b:general", text: "held during reconnect", decide: false, parentId: "gap-root", alsoChannel: false, files: [], replyTo: nil, createdAt: reply.createdAt, reason: "offline")
        bridgeGate.resolve(ChatThread(parent: gapRoot, replies: (51...100).map(numbered), more: true, nextCursor: "before-51"))
        check(await catchingUp.value)
        check(gapRequests.count == 3 && gapRequests[2] == "before-51")
        check(Set(reconnect.thread!.replies.map(\.id)) == Set((1...151).map { numbered($0).id } + ["tmp-gap"]))
        check(reconnect.thread!.replies.first { $0.id == "n001" }?.body == "edited while gap pending")
        check(!reconnect.thread!.hasOlder)
        func cacheHundred(_ target: ChatStore, make: @escaping (Int) -> ChatMessage, hasEarlier: Bool = false) async {
            ChatService.getPage = { cursor in
                if cursor == nil { return ChatThread(parent: gapRoot, replies: (51...100).map(make), more: true, nextCursor: "seed-before-51") }
                return ChatThread(parent: gapRoot, replies: (1...50).map(make), more: hasEarlier, nextCursor: hasEarlier ? "older-than-1" : nil)
            }
            check(await target.openThread(channel: "b:general", parentId: "gap-root"))
            await target.loadOlderThread()
            check(target.thread!.replies.count == 100)
        }
        // A deletion inside a reread window must not return from the cache.
        let offlineDelete = ChatStore()
        await cacheHundred(offlineDelete, make: numbered)
        // A surviving older reply and a held reply both quote deleted 90.
        var quotingOld = numbered(10); quotingOld.replyTo = ChatQuote(of: numbered(90))
        offlineDelete.upsert(quotingOld)
        offlineDelete.heldSends["tmp-deleted-quote"] = ChatOutbox.Entry(clientId: "tmp-deleted-quote", user: "alice", orgId: "A", view: "b:general", text: "held quote", decide: false, parentId: "gap-root", alsoChannel: false, files: [], replyTo: ChatQuote(of: numbered(90)), createdAt: reply.createdAt, reason: "offline")
        offlineDelete.closeThread()
        ChatService.getPage = { cursor in
            check(cursor == nil)
            return ChatThread(parent: gapRoot, replies: (50...100).filter { $0 != 90 }.map(numbered), more: true, nextCursor: "delete-before-50")
        }
        check(await offlineDelete.openThread(channel: "b:general", parentId: "gap-root"))
        check(offlineDelete.thread!.replies.count == 100, "99 live server rows and one held reply")
        check(!offlineDelete.thread!.replies.contains { $0.id == "n090" })
        check(offlineDelete.thread!.replies.first { $0.id == "n010" }?.replyTo?.deleted == true)
        check(offlineDelete.heldSends["tmp-deleted-quote"]?.replyTo?.deleted == true)
        check(offlineDelete.heldSends["tmp-deleted-quote"]?.replyTo?.excerpt == "")
        check(!offlineDelete.threadRanges[offlineDelete.viewKey("gap-root")!]!.ids.contains("n090"))
        check(!offlineDelete.thread!.hasOlder)
        // Even an absent visible row must invalidate quotes once its covered ID is missing.
        let absentCovered = ChatStore()
        await cacheHundred(absentCovered, make: numbered)
        absentCovered.upsert(quotingOld)
        absentCovered.thread?.replies.removeAll { $0.id == "n090" }
        absentCovered.messages["b:general"] = [numbered(90)]
        absentCovered.closeThread()
        ChatService.getPage = { _ in ChatThread(parent: gapRoot, replies: (50...100).filter { $0 != 90 }.map(numbered), more: true, nextCursor: "absent-before-50") }
        check(await absentCovered.openThread(channel: "b:general", parentId: "gap-root"))
        check(absentCovered.thread!.replies.first { $0.id == "n010" }?.replyTo?.deleted == true)
        check(absentCovered.messages["b:general"]!.isEmpty)
        // Boundary position comes from wire order, even when all dates tie and IDs run backwards.
        func reversedId(_ number: Int) -> ChatMessage {
            message(String(format: "reverse-%03d", 200 - number), parent: "gap-root")
        }
        let tiedDelete = ChatStore()
        await cacheHundred(tiedDelete, make: reversedId, hasEarlier: true)
        tiedDelete.closeThread()
        ChatService.getPage = { _ in ChatThread(parent: gapRoot, replies: (50...100).filter { $0 != 50 && $0 != 90 }.map(reversedId), more: true, nextCursor: "older-than-51") }
        check(await tiedDelete.openThread(channel: "b:general", parentId: "gap-root"))
        // 50 was before the actual boundary 51, so remains an unvalidated older row.
        check(tiedDelete.thread!.replies.contains { $0.id == reversedId(50).id })
        check(!tiedDelete.thread!.replies.contains { $0.id == reversedId(90).id })
        check(tiedDelete.thread!.replies.map(\.id) == (1...100).filter { $0 != 90 }.map { reversedId($0).id })
        check(tiedDelete.thread!.nextCursor == "older-than-1")
        // The raw lower boundary must itself be known; a later overlap cannot cover ties before it.
        let unknownBoundary = ChatStore()
        await cacheHundred(unknownBoundary, make: reversedId)
        unknownBoundary.closeThread()
        var boundaryRequests: [String?] = []
        var insertedBoundary = message("new-nonlexical-boundary", parent: "gap-root")
        insertedBoundary.createdAt = reply.createdAt
        ChatService.getPage = { cursor in
            boundaryRequests.append(cursor)
            if cursor == nil { return ChatThread(parent: gapRoot, replies: [insertedBoundary] + (51...100).filter { $0 != 90 }.map(reversedId), more: true, nextCursor: "before-new-boundary") }
            return ChatThread(parent: gapRoot, replies: (1...49).map(reversedId), more: false)
        }
        check(await unknownBoundary.openThread(channel: "b:general", parentId: "gap-root"))
        check(boundaryRequests.count == 2)
        check(!unknownBoundary.thread!.replies.contains { $0.id == reversedId(50).id || $0.id == reversedId(90).id })
        check(unknownBoundary.thread!.replies.contains { $0.id == insertedBoundary.id })
        // A real live event after capture survives the reread, independently of retained prefix.
        let liveRefresh = ChatStore(), refreshGate = Gate<ChatThread>()
        await cacheHundred(liveRefresh, make: numbered)
        liveRefresh.closeThread()
        ChatService.getPage = { _ in try await refreshGate.wait() }
        let refreshing = Task { await liveRefresh.openThread(channel: "b:general", parentId: "gap-root") }; await drain()
        var arrivingAfterCapture = numbered(101); arrivingAfterCapture.createdAt = "2026-10-03T09:00:00Z"
        liveRefresh.upsert(arrivingAfterCapture)
        let staleReactionResponse = Gate<ChatMessage?>()
        ChatService.postReaction = { _ in try await staleReactionResponse.wait() }
        let staleReaction = Task { await liveRefresh.react(numbered(90), "👍") }; await drain()
        refreshGate.resolve(ChatThread(parent: gapRoot, replies: (50...100).filter { $0 != 90 }.map(numbered), more: true, nextCursor: "live-before-50"))
        check(await refreshing.value)
        check(liveRefresh.thread!.replies.contains { $0.id == "n101" })
        check(!liveRefresh.thread!.replies.contains { $0.id == "n090" })
        staleReactionResponse.resolve(numbered(90).settingReaction("👍", mine: true, myRef: "me"))
        await staleReaction.value
        check(!liveRefresh.thread!.replies.contains { $0.id == "n090" }, "A late local overlay response cannot resurrect a covered deletion")
        // A live arrival cached before navigation cannot become continuity proof.
        let polluted = ChatStore()
        ChatService.getPage = { _ in ChatThread(parent: gapRoot, replies: (1...50).map(numbered), more: false) }
        check(await polluted.openThread(channel: "b:general", parentId: "gap-root"))
        polluted.upsert(numbered(150))
        check(polluted.thread!.replies.last!.id == "n150")
        check(polluted.threadRanges[polluted.viewKey("gap-root")!]!.ids == Set((1...50).map { numbered($0).id }))
        polluted.closeThread()
        var pollutedRequests: [String?] = []
        ChatService.getPage = { cursor in
            pollutedRequests.append(cursor)
            switch cursor {
            case nil: return ChatThread(parent: gapRoot, replies: (101...150).map(numbered), more: true, nextCursor: "polluted-101")
            case "polluted-101": return ChatThread(parent: gapRoot, replies: (51...100).map(numbered), more: true, nextCursor: "polluted-51")
            case "polluted-51": return ChatThread(parent: gapRoot, replies: (1...50).map(numbered), more: false)
            default: preconditionFailure("Unexpected polluted cursor")
            }
        }
        check(await polluted.openThread(channel: "b:general", parentId: "gap-root"))
        check(pollutedRequests.count == 3 && polluted.thread!.replies.count == 150 && !polluted.thread!.hasOlder)
        // An established empty server range must bridge to the beginning, not to a live row.
        let emptyRange = ChatStore()
        ChatService.getPage = { _ in ChatThread(parent: gapRoot, replies: [], more: false) }
        check(await emptyRange.openThread(channel: "b:general", parentId: "gap-root"))
        emptyRange.upsert(numbered(150)); emptyRange.closeThread()
        check(emptyRange.threadRanges[emptyRange.viewKey("gap-root")!]!.ids.isEmpty)
        var emptyRequests = 0
        ChatService.getPage = { cursor in
            emptyRequests += 1
            switch cursor {
            case nil: return ChatThread(parent: gapRoot, replies: (101...150).map(numbered), more: true, nextCursor: "empty-101")
            case "empty-101": return ChatThread(parent: gapRoot, replies: (51...100).map(numbered), more: true, nextCursor: "empty-51")
            case "empty-51": return ChatThread(parent: gapRoot, replies: (1...50).map(numbered), more: false)
            default: preconditionFailure("Unexpected empty-range cursor")
            }
        }
        check(await emptyRange.openThread(channel: "b:general", parentId: "gap-root"))
        check(emptyRequests == 3 && emptyRange.thread!.replies.count == 150 && !emptyRange.thread!.hasOlder)
        // A never-read live-only snapshot has no established server range/cursor.
        let unknownRange = ChatStore()
        unknownRange.thread = ChatThread(parent: gapRoot, replies: [])
        unknownRange.upsert(numbered(150)); unknownRange.closeThread()
        var unknownRequests = 0
        ChatService.getPage = { cursor in
            check(cursor == nil); unknownRequests += 1
            return ChatThread(parent: gapRoot, replies: (101...150).map(numbered), more: true, nextCursor: "unknown-101")
        }
        check(await unknownRange.openThread(channel: "b:general", parentId: "gap-root"))
        check(unknownRequests == 1 && unknownRange.thread!.hasOlder && unknownRange.thread!.nextCursor == "unknown-101")
        // Previously loaded earlier pages keep their earliest cursor after proven overlap.
        let earlierCache = ChatStore()
        earlierCache.thread = ChatThread(parent: gapRoot, replies: (21...120).map(numbered), more: true, nextCursor: "before-21")
        earlierCache.recordThreadRange(earlierCache.thread!, serverOrder: earlierCache.thread!.replies.map(\.id))
        earlierCache.closeThread()
        var earlierRequests: [String?] = []
        ChatService.getPage = { cursor in
            earlierRequests.append(cursor)
            switch cursor {
            case nil: return ChatThread(parent: gapRoot, replies: (221...270).map(numbered), more: true, nextCursor: "before-221")
            case "before-221": return ChatThread(parent: gapRoot, replies: (171...220).map(numbered), more: true, nextCursor: "before-171")
            case "before-171": return ChatThread(parent: gapRoot, replies: (121...170).map(numbered), more: true, nextCursor: "before-121")
            case "before-121": return ChatThread(parent: gapRoot, replies: (71...120).map(numbered), more: true, nextCursor: "before-71")
            default: preconditionFailure("Unexpected older cache cursor")
            }
        }
        check(await earlierCache.openThread(channel: "b:general", parentId: "gap-root"))
        check(earlierRequests.count == 4 && earlierCache.thread!.replies.count == 250)
        check(earlierCache.thread!.hasOlder && earlierCache.thread!.nextCursor == "before-21")
        // A broken bridge keeps cached history/error state and retry fetches the gap.
        let retryGap = ChatStore()
        retryGap.thread = ChatThread(parent: gapRoot, replies: (1...50).map(numbered), more: false)
        retryGap.recordThreadRange(retryGap.thread!, serverOrder: retryGap.thread!.replies.map(\.id))
        retryGap.closeThread()
        var failBridge = true
        ChatService.getPage = { cursor in
            if cursor == nil { return ChatThread(parent: gapRoot, replies: (101...150).map(numbered), more: true, nextCursor: "gap-retry") }
            if failBridge { throw URLError(.notConnectedToInternet) }
            if cursor == "gap-retry" { return ChatThread(parent: gapRoot, replies: (51...100).map(numbered), more: true, nextCursor: "gap-retry-oldest") }
            return ChatThread(parent: gapRoot, replies: (1...50).map(numbered), more: false)
        }
        check(!(await retryGap.openThread(channel: "b:general", parentId: "gap-root")))
        check(retryGap.threadFailed && !retryGap.threadLoading && retryGap.thread!.replies.count == 50)
        failBridge = false
        await retryGap.retryThread()
        check(!retryGap.threadFailed && retryGap.thread!.replies.count == 150)
        // Scope changes while a gap page is pending cannot install stale history.
        let scopeGap = ChatStore(), scopeBridge = Gate<ChatThread>()
        scopeGap.thread = ChatThread(parent: gapRoot, replies: (1...50).map(numbered), more: false)
        scopeGap.recordThreadRange(scopeGap.thread!, serverOrder: scopeGap.thread!.replies.map(\.id))
        scopeGap.closeThread()
        ChatService.getPage = { cursor in
            if cursor == nil { return ChatThread(parent: gapRoot, replies: (101...150).map(numbered), more: true, nextCursor: "scope-gap") }
            return try await scopeBridge.wait()
        }
        let scopeCatchup = Task { await scopeGap.openThread(channel: "b:general", parentId: "gap-root") }; await drain()
        scopeGap.scopeGeneration = UUID(); scopeGap.closeThread()
        scopeBridge.resolve(ChatThread(parent: gapRoot, replies: (51...100).map(numbered), more: true, nextCursor: "stale-oldest"))
        check(!(await scopeCatchup.value) && scopeGap.thread == nil && !scopeGap.threadLoading)
        // Equal timestamps retain wire order rather than sorting arbitrary IDs.
        let wireOrder = ChatStore()
        let tiedMessages = ["z-id", "a-id", "m-id"].map { message($0, parent: "tie-root") }
        ChatService.getPage = { _ in ChatThread(parent: message("tie-root"), replies: tiedMessages, more: false) }
        check(await wireOrder.openThread(channel: "b:general", parentId: "tie-root"))
        check(wireOrder.thread!.replies.map(\.id) == ["z-id", "a-id", "m-id"])
        // A Threads summary has no older-page cursor; overlap cannot make it complete.
        let summary = ChatStore()
        summary.threads = [ChatThreadItem(parent: gapRoot, replies: [numbered(149), numbered(150)], replyCount: 150, lastReplyAt: reply.createdAt, unread: true)]
        var summaryRequests = 0
        ChatService.getPage = { cursor in
            check(cursor == nil); summaryRequests += 1
            return ChatThread(parent: gapRoot, replies: (101...150).map(numbered), more: true, nextCursor: "summary-older")
        }
        check(await summary.openThread(channel: "b:general", parentId: "gap-root"))
        check(summaryRequests == 1 && summary.thread!.hasOlder && summary.thread!.nextCursor == "summary-older")
        // The reference decoder accepts both contracts, and rejects wrong roots/deletions.
        let source = message("legacy-reply", parent: "legacy-root")
        let sourceJSON = try JSONEncoder().encode(source)
        let boundedJSON = Data("{\"reference\":\(String(decoding: sourceJSON, as: UTF8.self))}".utf8)
        let boundedResponse = try JSONDecoder().decode(ChatThreadReferenceResponse.self, from: boundedJSON)
        check(try boundedResponse.message(channel: "b:general", parentId: "legacy-root", messageId: source.id).id == source.id)
        let completeJSON = try JSONEncoder().encode(ChatThread(parent: message("legacy-root"), replies: [source]))
        let legacyResponse = try JSONDecoder().decode(ChatThreadReferenceResponse.self, from: completeJSON)
        check(try legacyResponse.message(channel: "b:general", parentId: "legacy-root", messageId: source.id).id == source.id)
        do { _ = try legacyResponse.message(channel: "b:general", parentId: "wrong-root", messageId: source.id); preconditionFailure("Wrong root accepted") } catch {}
        var deletedSource = source; deletedSource.deleted = true
        let deletedJSON = try JSONEncoder().encode(ChatThread(parent: message("legacy-root"), replies: [deletedSource]))
        let deletedResponse = try JSONDecoder().decode(ChatThreadReferenceResponse.self, from: deletedJSON)
        do { _ = try deletedResponse.message(channel: "b:general", parentId: "legacy-root", messageId: source.id); preconditionFailure("Deleted source accepted") } catch {}
        // Legacy child-reaction timeout reconciles the committed toggle without reposting.
        ChatService.getPage = nil
        var committedChild = source; committedChild.reactions = [ChatReaction(emoji: "👍", count: 1, refs: ["me"], mine: true)]
        let committedLegacyJSON = try JSONEncoder().encode(ChatThread(parent: message("legacy-root"), replies: [committedChild]))
        ChatService.getReference = { id in try JSONDecoder().decode(ChatThreadReferenceResponse.self, from: committedLegacyJSON).message(channel: "b:general", parentId: "legacy-root", messageId: id) }
        let legacyReaction = ChatStore(), legacyTimeout = Gate<ChatMessage?>()
        legacyReaction.thread = ChatThread(parent: message("legacy-root"), replies: [source])
        var legacyPosts = 0
        ChatService.postReaction = { _ in legacyPosts += 1; return try await legacyTimeout.wait() }
        let oldReaction = Task { await legacyReaction.react(source, "👍") }; await drain()
        legacyTimeout.reject(URLError(.timedOut)); await oldReaction.value
        check(legacyPosts == 1 && legacyReaction.thread!.replies[0].reactions?.first?.mine == true)
        check(legacyReaction.thread!.replies[0].reactions?.first?.status == nil)
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
        print("Native chat regressions passed: linked reads/races, quotes/outbox, optimistic reactions/reconciliation, media scope, displayed read cutoff, bounded pages/cache/reference context, reconnect gaps/ties/retry/scope, legacy reference/reaction reconciliation, server-only range provenance, covered-window deletions/quotes/ties/live changes.")
    }
}
'''

with tempfile.TemporaryDirectory(prefix='honmaru-native-chat-') as directory:
    path = Path(directory)
    (path / 'main.swift').write_text('import Foundation\n' + models + stubs + methods + checks)
    subprocess.run(['swiftc', '-swift-version', '5', '-parse-as-library', str(path / 'main.swift'), '-o', str(path / 'checks')], check=True)
    subprocess.run([str(path / 'checks')], check=True)
