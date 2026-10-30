import SwiftUI
import PhotosUI
import UIKit
import ImageIO
import AVFoundation
import UniformTypeIdentifiers

/// A thread, as a sheet over the conversation: the message, its replies,
/// and a composer that answers under it.
struct ChatThreadSheet: View {
    @ObservedObject var store: ChatStore
    let onOpenCard: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var draft = ""
    /// "Also send to the conversation": for the next reply only.
    @State private var alsoChannel = false
    @State private var unsent: (text: String, clientId: String)?
    @State private var reactingTo: ChatMessage?
    /// Photos for the next reply: uploaded as soon as they are picked, as
    /// in the conversation.
    @State private var photoItems: [PhotosPickerItem] = []
    @State private var attached: [ChatFile] = []
    @State private var uploading = 0
    @State private var mediaSelection = UUID()
    /// Photos were picked past what one reply carries, and left out.
    @State private var photoLimitNote = false
    @FocusState private var focused: Bool
    @AccessibilityFocusState private var referenceButtonFocused: Bool
    /// Whether the newest reply is in view. There, what arrives is scrolled
    /// to; up in the earlier replies, the place is kept and what arrived is
    /// counted on the way back down.
    @State private var atBottom = false
    @State private var unseen = 0
    /// The reply the next one answers, inline (swiped, or Reply).
    @State private var replyingTo: ChatMessage?
    /// A quote pressed: the reply it quotes, to scroll to.
    @State private var quoteJump: String?
    /// The reply the thread was opened at, marked for a moment.
    @State private var highlight: String?

    var body: some View {
        NavigationStack {
            ScrollViewReader { proxy in
            ScrollView {
                if let t = store.thread {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        row(t.parent)
                        HStack(spacing: 8) {
                            // While the replies are read: the count the
                            // conversation already showed, and that they are
                            // coming — not "0 replies" over an empty sheet.
                            let known = store.threadLoading || store.threadFailed || t.hasOlder ? max(t.replies.count, t.parent.replyCount ?? 0) : t.replies.count
                            Text(known == 1 ? String(localized: "1 reply") : String(localized: "\(known) replies"))
                                .font(.caption.weight(.semibold)).foregroundStyle(Theme.Colors.textSecondary)
                            if store.threadLoading && t.replies.count < known {
                                ProgressView().controlSize(.mini)
                                Text("Loading replies…").font(.caption).foregroundStyle(Theme.Colors.textTertiary)
                            }
                            VStack { Divider() }
                        }.padding(.horizontal, 16).padding(.vertical, 8)
                        if store.threadFailed { failedNote(t.parent) }
                        historyControls(t, proxy: proxy)
                        ForEach(t.replies) { row($0) }
                        // The replies still on their way, in their shape.
                        if store.threadLoading, (t.parent.replyCount ?? 0) > t.replies.count {
                            ChatSkeletonMessages(count: min((t.parent.replyCount ?? 0) - t.replies.count, 3))
                        }
                        if let step = store.thinking[t.parent.channel] { ChatAISteps(step: step).padding(.vertical, 6) }
                        ForEach((store.agentTyping[t.parent.channel] ?? []).filter { $0.parentId == nil || $0.parentId == t.parent.id }, id: \.agent.id) { typing in
                            ChatAgentTypingRow(agent: typing.agent).padding(.vertical, 6)
                        }
                        ChatBottomMarker(atBottom: $atBottom).id(Self.bottom)
                    }
                } else if store.threadFailed {
                    failedNote(nil)
                } else {
                    Text("Loading thread…").font(.caption).accessibilityAddTraits(.updatesFrequently)
                    ChatSkeletonMessages(count: 4).padding(.top, 8)
                }
            }
            .defaultScrollAnchor(.bottom)
            .modifier(ChatTracksBottom(atBottom: $atBottom))
            // A reply arriving: followed when the newest was in view, or when
            // it is your own; otherwise left below and counted.
            .onChange(of: store.thread?.replies.last?.id) { old, new in
                guard new != nil, new != old, let old, let t = store.thread,
                      let previous = t.replies.firstIndex(where: { $0.id == old }) else { return }
                let arrived = t.replies.count - previous - 1
                guard arrived > 0 else { return }
                if atBottom || t.replies.last?.mine == true {
                    withAnimation { proxy.scrollTo(Self.bottom, anchor: .bottom) }
                } else {
                    unseen += arrived
                }
            }
            .onChange(of: store.thread.map { store.thinking[$0.parent.channel] != nil } ?? false) { _, _ in
                if atBottom { withAnimation { proxy.scrollTo(Self.bottom, anchor: .bottom) } }
            }
            .onChange(of: atBottom) { _, now in if now { unseen = 0 } }
            // What arrives while the newest reply is in view is read.
            .modifier(ReadsOpenThread(store: store, atBottom: atBottom))
            .onChange(of: quoteJump) { _, id in
                guard let id else { return }
                quoteJump = nil
                if store.thread?.replies.contains(where: { $0.id == id }) == true || store.thread?.parent.id == id {
                    withAnimation { proxy.scrollTo(id, anchor: .center) }
                } else {
                    Task { await store.loadThreadReference(id) }
                }
            }
            // Opened at one reply (Search, Activity, Sent, a notification):
            // there, marked for a moment, once the replies have been read.
            .onChange(of: jumpReplyIsHere, initial: true) { _, found in
                guard found, let id = store.threadJump else { return }
                store.threadJump = nil
                highlight = id
                let target = store.thread?.parent.id
                let presentation = store.threadPresentation
                Task {
                    try? await Task.sleep(for: .milliseconds(300))
                    guard !Task.isCancelled, store.threadPresentation == presentation, store.thread?.parent.id == target else { return }
                    withAnimation { proxy.scrollTo(id, anchor: .center) }
                    try? await Task.sleep(for: .seconds(1.6))
                    if highlight == id { withAnimation { highlight = nil } }
                }
            }
            .overlay(alignment: .bottom) {
                if !atBottom && store.thread != nil {
                    Button {
                        withAnimation { proxy.scrollTo(Self.bottom, anchor: .bottom) }
                    } label: {
                        Label(unseen == 0 ? String(localized: "Jump to latest reply") : (unseen == 1 ? String(localized: "1 new reply") : String(localized: "\(unseen) new replies")),
                              systemImage: "arrow.down")
                            .font(.footnote.weight(.semibold))
                            .padding(.horizontal, 14).padding(.vertical, 8)
                            .glassPanel(cornerRadius: 18, interactive: true)
                    }
                    .buttonStyle(.plain)
                    .padding(.bottom, 8)
                    .transition(.opacity)
                    .accessibilityIdentifier("threadJumpToLatest")
                }
            }
            .safeAreaInset(edge: .bottom) {
                VStack(alignment: .leading, spacing: 4) {
                    if let quote = replyQuote {
                        ChatReplyingBar(quote: quote, nameOf: store.nameOf(ref:)) { replyingTo = nil }
                    }
                    Toggle(isOn: $alsoChannel) {
                        Text(alsoChannelLabel).font(.footnote).foregroundStyle(Theme.Colors.textSecondary)
                    }
                    .tint(Theme.Colors.accent).controlSize(.small)
                    .padding(.horizontal, 16)
                    .accessibilityIdentifier("alsoSendToChannel")
                    if !attached.isEmpty || uploading > 0 {
                        ChatAttachedStrip(store: store, attached: $attached, uploading: uploading).padding(.horizontal, 12)
                    }
                    if photoLimitNote {
                        Text("A message can carry at most 10 files.")
                            .font(.footnote).foregroundStyle(Theme.Colors.textSecondary)
                            .padding(.horizontal, 16)
                    }
                    // "@" offers names here too, as in the conversation.
                    if let channel = store.thread?.parent.channel {
                        ChatMentionSuggestions(store: store, view: channel, draft: $draft)
                    }
                    HStack(alignment: .bottom, spacing: 8) {
                        let photoRoom = ChatPhotos.room(attached: attached.count, uploading: uploading)
                        PhotosPicker(selection: $photoItems, maxSelectionCount: max(photoRoom, 1), matching: .any(of: [.images, .videos])) {
                            Image(systemName: "plus").font(.system(size: 17, weight: .semibold))
                                .foregroundStyle(photoRoom == 0 ? Theme.Colors.textTertiary : Theme.Colors.textSecondary)
                                .frame(width: 44, height: 44).glassCircle()
                        }
                        .disabled(photoRoom == 0)
                        .accessibilityLabel("Add photos or videos")
                        .onChange(of: photoItems) { _, items in
                            guard !items.isEmpty, let channel = store.thread?.parent.channel else { return }
                            photoItems = []
                            let taken = Array(items.prefix(ChatPhotos.room(attached: attached.count, uploading: uploading)))
                            photoLimitNote = taken.count < items.count
                            guard !taken.isEmpty else { return }
                            // Their places are kept from now, before the first has gone up.
                            uploading += taken.count
                            guard let origin = store.mediaScope(channel), let parentId = store.thread?.parent.id else { uploading -= taken.count; return }
                            let selection = mediaSelection
                            Task {
                                let files = await ChatPhotos.upload(taken, origin: origin, store: store)
                                guard store.isCurrent(origin), mediaSelection == selection, store.thread?.parent.id == parentId else { return }
                                attached.append(contentsOf: files)
                                uploading = max(0, uploading - taken.count)
                            }
                        }
                        TextField("Reply… — @AI to ask the AI", text: $draft, axis: .vertical)
                            .lineLimit(1...5).focused($focused)
                            .padding(.horizontal, 16).padding(.vertical, 11)
                            .glassPanel(cornerRadius: 22, interactive: true)
                        Button {
                            guard let t = store.thread else { return }
                            let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
                            let files = attached
                            guard !text.isEmpty || !files.isEmpty, uploading == 0 else { return }
                            let both = alsoChannel
                            let quote = replyQuote
                            let clientId = unsent?.text == text ? unsent!.clientId : ChatService.newClientId()
                            // Out of the box at once and into the thread, faded
                            // until the server has it: one tap is one reply.
                            draft = ""
                            alsoChannel = false
                            attached = []
                            photoLimitNote = false
                            Task {
                                let went = await store.send(t.parent.channel, text: text, parentId: t.parent.id, alsoChannel: both, replyTo: quote, files: files, clientId: clientId)
                                if went || store.isHeld(clientId) {
                                    unsent = nil
                                    if replyingTo?.id == quote?.id { replyingTo = nil }
                                }
                                else {
                                    unsent = (text, clientId)
                                    if draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { draft = text; alsoChannel = both }
                                    if attached.isEmpty { attached = files }
                                }
                            }
                        } label: {
                            Image(systemName: "arrow.up").font(.system(size: 17, weight: .bold)).foregroundStyle(.white)
                                .frame(width: 44, height: 44).glassCircle(tint: Theme.Colors.accent)
                        }
                        .disabled(uploading > 0 || (draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && attached.isEmpty))
                        .accessibilityLabel("Send")
                    }.padding(.horizontal, 12)
                }.padding(.vertical, 8)
            }
            .navigationTitle("Thread").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarTrailing) { CloseButton { dismiss() } } }
            // Its message deleted, the thread went with it: nothing left to show.
            .onChange(of: store.thread?.parent.id, initial: true) { old, new in
                mediaSelection = UUID(); attached = []; uploading = 0
                alsoChannel = false
                atBottom = false
                unseen = 0
                replyingTo = nil
                // A reply half-written in a thread is kept, per thread, and
                // is there again when the thread is opened again.
                draft = new.map { store.draft("thread:\($0)") } ?? ""
                if old != nil && new == nil && !store.threadLoading { dismiss() }
            }
            .onChange(of: draft) { _, text in
                if let id = store.thread?.parent.id { store.setDraft("thread:\(id)", text) }
            }
            .sheet(item: $reactingTo) { m in ChatEmojiPicker { e in Task { await store.react(m, e) } } }
            .sheet(item: $store.threadReference, onDismiss: { referenceButtonFocused = true }) { message in
                ChatThreadReferenceSheet(message: message) { store.threadReference = nil }
            }
            }
        }
        // Everyone's photos and the workspace's emoji, however the sheet was opened.
        .onDisappear { mediaSelection = UUID(); attached = []; uploading = 0; store.closeThread() }
        .environment(\.chatAssets, store.assets)
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }

    @ViewBuilder
    private func historyControls(_ t: ChatThread, proxy: ScrollViewProxy) -> some View {
        if let reference = store.threadReferenceId {
            VStack(alignment: .leading, spacing: 4) {
                if store.threadReferenceLoading {
                    ProgressView("Loading linked reply…")
                } else {
                    if store.threadReferenceFailed { Text("That reply is unavailable. It may have been deleted, or you may no longer have access.").font(.caption) }
                    Button(store.threadReferenceFailed ? "Try linked reply again" : "View linked reply") {
                        Task { await store.loadThreadReference(reference) }
                    }
                    .accessibilityFocused($referenceButtonFocused)
                }
            }.padding(.horizontal, 16).padding(.vertical, 8)
        }
        if t.hasOlder || store.threadOlderFailed {
            Button {
                let anchor = t.replies.first?.id
                let presentation = store.threadPresentation
                Task {
                    await store.loadOlderThread()
                    guard store.threadPresentation == presentation, store.thread?.parent.id == t.parent.id, let anchor else { return }
                    proxy.scrollTo(anchor, anchor: .top)
                }
            } label: {
                if store.threadOlderLoading { ProgressView("Loading earlier replies…") }
                else { Text(store.threadOlderFailed ? "Couldn't load earlier replies. Try again" : "Load earlier replies") }
            }
            .disabled(store.threadOlderLoading)
            .font(.caption.weight(.semibold)).padding(.horizontal, 16).padding(.vertical, 8)
            .accessibilityIdentifier("threadLoadOlder")
        }
    }

    private static let bottom = "threadBottom"

    /// Whether the reply the thread was opened at has been read yet.
    private var jumpReplyIsHere: Bool {
        guard let id = store.threadJump else { return false }
        return store.thread?.replies.contains { $0.id == id } ?? false
    }

    /// "Also send to #name" in a channel; elsewhere, to the conversation.
    private var alsoChannelLabel: String {
        guard let view = store.thread?.parent.channel else { return String(localized: "Also send to the conversation") }
        if view.hasPrefix("b:"), let c = store.businesses.first(where: { "b:\($0.slug)" == view }) {
            return String(localized: "Also send to #\(c.name)")
        }
        return String(localized: "Also send to the conversation")
    }

    /// The quote the next reply carries, of that reply as it is now.
    private var replyQuote: ChatQuote? {
        guard let r = replyingTo else { return nil }
        return store.quote(of: r)
    }

    /// Answer this one. Every reply here answers the thread's first message
    /// already, so answering that one is just the box; a reply is quoted.
    private func startReply(_ m: ChatMessage) {
        replyingTo = m.id == store.thread?.parent.id ? nil : m
        focused = true
    }

    /// The replies could not be read: said, with a way to read them again,
    /// under what is already on screen.
    private func failedNote(_ parent: ChatMessage?) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "exclamationmark.triangle").foregroundStyle(Theme.Colors.textTertiary)
            Text("Couldn't load the replies.").font(.caption).foregroundStyle(Theme.Colors.textSecondary)
            Button("Try again") {
                Task {
                    if let parent { await store.openThread(parent) }
                    else { await store.retryThread() }
                }
            }.font(.caption.weight(.semibold))
            Spacer(minLength: 0)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Could not load the current thread. Try again.")
        .padding(.horizontal, 16).padding(.vertical, parent == nil ? 40 : 6)
    }

    private func row(_ m: ChatMessage) -> some View {
        ChatMessageRow(message: m, inThread: true, highlighted: highlight == m.id, nameOf: store.nameOf(ref:),
                       onReact: { e in Task { await store.react(m, e) } },
                       onAddReaction: { reactingTo = m },
                       onOpenThread: {}, onOpenCard: onOpenCard, onProfile: { _ in },
                       onOpenQuote: { quoteJump = $0 })
            .modifier(ChatSendState(message: m))
            // Swiped to the left: answered, as in the conversation (#237).
            .modifier(ChatSwipeToReply(enabled: !m.isDeleted && !m.id.hasPrefix("tmp-")) { startReply(m) })
            .id(m.id)
            .contextMenu {
                if !m.isDeleted && !m.id.hasPrefix("tmp-") {
                    Button { startReply(m) } label: { Label("Reply", systemImage: "arrowshape.turn.up.left") }
                    Button { reactingTo = m } label: { Label("Add reaction", systemImage: "face.smiling") }
                    Button { UIPasteboard.general.string = m.body } label: { Label("Copy text", systemImage: "doc.on.doc") }
                    Button {
                        Task { if let url = await store.messageLink(m) { UIPasteboard.general.url = url; UIPasteboard.general.string = url.absoluteString } }
                    } label: { Label("Copy link", systemImage: "link") }
                    if m.mine && m.kind == "message" {
                        Button(role: .destructive) { Task { await store.delete(m) } } label: { Label("Delete message", systemImage: "trash") }
                    }
                }
            }
    }
}

/// A teammate: who, their clock, how they are with decisions.
struct ChatProfileSheet: View {
    @ObservedObject var store: ChatStore
    let ref: String
    var onMessage: ((String) -> Void)? = nil
    @Environment(\.dismiss) private var dismiss
    @State private var profile: ChatProfile?
    /// Nothing kept and nothing read: said so, with a way to try again.
    @State private var failed = false

    var body: some View {
        NavigationStack {
            ScrollView {
                if let p = profile {
                    VStack(spacing: 14) {
                        ChatAvatar(name: p.name, size: 96, url: store.avatar(of: p.ref)).padding(.top, 20)
                        VStack(spacing: 4) {
                            Text(p.name).font(.title2.weight(.bold))
                            if let h = p.handle { Text(verbatim: "@\(h)").font(.subheadline).foregroundStyle(Theme.Colors.textSecondary) }
                            Text(LocalizedStringKey(p.title.prefix(1).uppercased() + p.title.dropFirst())).font(.subheadline).foregroundStyle(Theme.Colors.textSecondary)
                        }
                        if let s = p.status, (s.emoji ?? s.text) != nil {
                            Text(verbatim: "\(s.emoji ?? "") \(s.text ?? "")").font(.subheadline).padding(.horizontal, 14).padding(.vertical, 8).glassCapsule()
                        }
                        if let away = ChatDates.parse(p.awayUntil) {
                            Label("Away until \(away.formatted(date: .abbreviated, time: .omitted))", systemImage: "moon.zzz").font(.subheadline.weight(.semibold)).foregroundStyle(.orange)
                        }
                        if let tz = p.timezone, let zone = TimeZone(identifier: tz) {
                            Label {
                                Text("\(Date.now.formatted(Date.FormatStyle(date: .omitted, time: .shortened, timeZone: zone))) local time")
                            } icon: { Image(systemName: "clock") }
                            .font(.subheadline).foregroundStyle(Theme.Colors.textSecondary)
                        }
                        HStack(spacing: 0) {
                            stat("Waiting on them", "\(p.stats.waiting)")
                            Divider().frame(height: 40)
                            stat("Decided (90 days)", "\(p.stats.decided90d)")
                            Divider().frame(height: 40)
                            stat("Typical answer", typical(p.stats.medianMinutes))
                        }
                        .padding(.vertical, 12)
                        .glassPanel(cornerRadius: 18)
                        .padding(.horizontal, 20)
                        if p.mine != true, let onMessage {
                            Button { dismiss(); onMessage(p.ref) } label: {
                                Label("Message", systemImage: "bubble.left").frame(maxWidth: .infinity).padding(.vertical, 12)
                            }.buttonStyle(.borderedProminent).tint(Theme.Colors.accent).padding(.horizontal, 20)
                        }
                    }
                } else if failed {
                    VStack(spacing: 12) {
                        Text("Couldn't load this profile.").foregroundStyle(Theme.Colors.textSecondary)
                        Button("Try again") { Task { await load() } }
                    }.padding(60)
                } else {
                    ProgressView().padding(60)
                }
            }
            .navigationTitle("Profile").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarTrailing) { CloseButton { dismiss() } } }
            .task { await load() }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }

    /// What was read before, at once; the server's, when it answers.
    private func load() async {
        failed = false
        if profile == nil { profile = store.cachedProfile(ref) }
        if let fresh = await store.profile(ref) { profile = fresh } else if profile == nil { failed = true }
    }

    private func stat(_ label: LocalizedStringKey, _ value: String) -> some View {
        VStack(spacing: 4) {
            Text(value).font(.title3.weight(.bold)).monospacedDigit()
            Text(label).font(.caption2).foregroundStyle(Theme.Colors.textSecondary).multilineTextAlignment(.center)
        }.frame(maxWidth: .infinity)
    }

    private func typical(_ minutes: Int?) -> String {
        guard let m = minutes else { return "—" }
        if m < 60 { return String(localized: "\(m) min") }
        if m < 1440 { return String(localized: "\(m / 60) h") }
        return String(localized: "\(m / 1440) days")
    }
}

/// Activity: what named you, and replies in your threads.
struct ChatActivityView: View {
    @ObservedObject var store: ChatStore
    @ObservedObject private var translations = ChatTranslations.shared
    var body: some View {
        List {
            if store.inbox.isEmpty && !store.loaded.contains("inbox") {
                ChatSkeletonRows()
                    .listRowInsets(EdgeInsets()).listRowSeparator(.hidden).listRowBackground(Color.clear)
            } else if store.inbox.isEmpty {
                ContentUnavailableView("Nothing for you yet", systemImage: "bell",
                                       description: Text("When somebody writes @ your name, or replies in a thread you are part of, it shows up here."))
            }
            ForEach(store.inbox) { item in
                NavigationLink(value: ChatRoute.conversation(view: item.message.channel, jump: item.message.id, thread: item.message.parentId)) {
                    VStack(alignment: .leading, spacing: 4) {
                        HStack {
                            if item.unread { Circle().fill(Theme.Colors.interactive).frame(width: 8, height: 8) }
                            Text(label(item))
                                .font(.caption).foregroundStyle(Theme.Colors.textSecondary)
                            Spacer()
                            TimeAgo(date: item.message.date).font(.caption2).foregroundStyle(Theme.Colors.textTertiary)
                        }
                        Text(item.message.isAI ? String(localized: "Your AI") : (item.message.authorName ?? "")).font(.subheadline.weight(.semibold))
                        Text(translations.shown(item.message).text).font(.subheadline).lineLimit(3).foregroundStyle(Theme.Colors.textPrimary)
                    }.padding(.vertical, 4)
                }
                // Seen is read: on screen for a moment, it is no longer new
                // here or on any other device. Tapping it does the same.
                .task(id: item.unread) {
                    guard item.unread else { return }
                    try? await Task.sleep(for: .milliseconds(900))
                    guard !Task.isCancelled else { return }
                    await store.seenInbox([item.id])
                }
                .simultaneousGesture(TapGesture().onEnded { Task { await store.seenInbox([item.id]) } })
            }
        }
        .listStyle(.plain)
        .navigationTitle("Activity")
        .toolbar {
            if store.unreadInbox > 0 {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Mark all as read") { Task { await store.markAllInboxRead() } }
                        .accessibilityIdentifier("activity.markAll")
                }
            }
        }
        .refreshable { await store.loadInbox() }
        .task {
            await store.loadInbox()
            // In the language you set, by the conversation each came from.
            for (channel, list) in Dictionary(grouping: store.inbox.map(\.message).filter { !$0.mine }, by: \.channel) {
                await store.translate(channel, list)
            }
        }
    }
    private func place(_ view: String) -> String {
        guard let c = store.conversation(for: view) else { return "" }
        return c.kind == .channel ? "#\(c.name)" : c.name
    }
    private func label(_ item: ChatActivityItem) -> String {
        let where_ = place(item.message.channel)
        switch item.type {
        case "mention": return String(localized: "Mentioned you in \(where_)")
        case "keyword": return String(localized: "Said “\(item.keyword ?? "")” in \(where_)")
        case "reaction": return String(localized: "Reacted in \(where_)")
        default: return String(localized: "Replied in a thread in \(where_)")
        }
    }
}

/// Later: messages saved to come back to.
struct ChatLaterView: View {
    @ObservedObject var store: ChatStore
    @ObservedObject private var translations = ChatTranslations.shared
    var body: some View {
        List {
            if store.saved.isEmpty {
                ContentUnavailableView("Nothing saved", systemImage: "bookmark",
                                       description: Text("Long-press any message and pick Save for later."))
            }
            ForEach(store.saved) { item in
                NavigationLink(value: ChatRoute.conversation(view: item.message.channel, jump: item.message.id, thread: item.message.parentId)) {
                    VStack(alignment: .leading, spacing: 4) {
                        if let at = ChatDates.parse(item.remindAt) {
                            Label(item.remindedAt == nil ? String(localized: "Reminder \(at.formatted(date: .abbreviated, time: .shortened))") : String(localized: "Reminded"), systemImage: "alarm")
                                .font(.caption).foregroundStyle(.orange)
                        }
                        Text(item.message.isAI ? String(localized: "Your AI") : (item.message.mine ? String(localized: "You") : item.message.authorName ?? "")).font(.subheadline.weight(.semibold))
                        Text(translations.shown(item.message).text).font(.subheadline).lineLimit(3)
                    }.padding(.vertical, 4)
                }
                .swipeActions {
                    Button { Task { await store.finishLater(item) } } label: { Label("Done", systemImage: "checkmark") }.tint(Theme.Colors.approve)
                }
            }
        }
        .listStyle(.plain)
        .navigationTitle("Later")
        .refreshable { await store.loadLater() }
        .task {
            await store.loadLater()
            // In the language you set, by the conversation each came from.
            for (channel, list) in Dictionary(grouping: store.saved.map(\.message).filter { !$0.mine }, by: \.channel) {
                await store.translate(channel, list)
            }
        }
    }
}

/// Your name, your @username, your status, and being away.
struct ChatStatusEditor: View {
    @ObservedObject var store: ChatStore
    @EnvironmentObject private var appState: AppState
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var handle = ""
    @State private var emoji = ""
    @State private var text = ""
    @State private var clear = 1
    @State private var away = false
    @State private var awayUntil = Date().addingTimeInterval(86400 * 3)
    @State private var delegate = ""
    /// Your agent answering for you when you are mentioned.
    @State private var proxyOn = false
    @State private var proxyTeammate = true
    @State private var proxyLoaded: ChatService.ChatProxy?
    @State private var saving = false
    @State private var problem: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Name", text: $name).textContentType(.name)
                    HStack(spacing: 2) {
                        Text("@").foregroundStyle(Theme.Colors.textSecondary)
                        TextField("e.g. toru", text: $handle).textInputAutocapitalization(.never).autocorrectionDisabled()
                            .onChange(of: handle) { _, v in handle = v.lowercased().replacingOccurrences(of: "@", with: "") }
                    }
                } header: { Text("Profile") } footer: {
                    Text("What @ finds you by — in a channel, on a card, when you tell your AI. Letters, numbers, “.”, “_” and “-”.")
                }
                Section {
                    HStack {
                        TextField("🙂", text: $emoji).frame(width: 44).multilineTextAlignment(.center)
                        TextField("e.g. In meetings until 3", text: $text)
                    }
                    Picker("Clear after", selection: $clear) {
                        Text("Clear in 1 hour").tag(0)
                        Text("Clear tonight").tag(1)
                        Text("Clear this week").tag(2)
                        Text("Don’t clear").tag(3)
                    }
                } header: { Text("Status") } footer: { Text("Shown beside your name in the list and on your profile.") }
                Section {
                    Toggle("Away", isOn: $away.animation())
                    if away {
                        DatePicker("Away until", selection: $awayUntil, in: Date()..., displayedComponents: .date)
                        Picker("Who decides meanwhile", selection: $delegate) {
                            Text("Nobody — they wait for me").tag("")
                            ForEach(store.members.filter { !$0.mine }) { m in Text(m.name).tag(m.ref) }
                        }
                    }
                } footer: { Text("While you are away, new decisions for you go to the person you pick, and say they are covering for you.") }
                if proxyLoaded != nil {
                    Section {
                        Toggle("My agent answers when I am mentioned", isOn: $proxyOn.animation())
                            .accessibilityIdentifier("proxyToggle")
                        if proxyOn {
                            Toggle("Code work goes to the AI teammate (Claude)", isOn: $proxyTeammate)
                        }
                    } footer: {
                        Text("When someone mentions you and asks for something, your agent does it and answers in the thread as your agent. Anything it would post outside the chat, such as a comment on GitHub, waits for your approval.")
                    }
                }
                if let problem { Section { Text(problem).foregroundStyle(.red) } }
            }
            .navigationTitle("You").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button("Save") { Task { await save() } }.disabled(saving) }
            }
            .task { await load() }
        }
    }

    private func load() async {
        guard let base = appState.backendBaseURL else { return }
        if let me = try? await ChatService.me(base: base) { name = me.name ?? ""; handle = me.handle ?? "" }
        if let s = store.mine?.status { emoji = s.emoji ?? ""; text = s.text ?? "" }
        if let a = ChatDates.parse(store.mine?.awayUntil) { away = true; awayUntil = a; delegate = store.mine?.delegateRef ?? "" }
        if let orgId = appState.currentUser?.teamID, let p = try? await ChatService.proxy(orgId: orgId, base: base) {
            proxyLoaded = p; proxyOn = p.enabled; proxyTeammate = p.useTeammate
        }
    }

    private func save() async {
        guard let base = appState.backendBaseURL, let orgId = appState.currentUser?.teamID else { return }
        saving = true; defer { saving = false }
        do {
            _ = try await ChatService.saveIdentity(name: name.trimmingCharacters(in: .whitespaces).isEmpty ? nil : name, handle: handle, base: base)
            let until: Date? = {
                switch clear {
                case 0: return .now.addingTimeInterval(3600)
                case 1: return Calendar.current.date(bySettingHour: 23, minute: 59, second: 0, of: .now)
                case 2: return Calendar.current.date(byAdding: .day, value: 7 - Calendar.current.component(.weekday, from: .now) + 1, to: .now)
                default: return nil
                }
            }()
            let hasStatus = !(emoji.isEmpty && text.isEmpty)
            let end = away ? Calendar.current.date(bySettingHour: 23, minute: 59, second: 0, of: awayUntil) : nil
            try await ChatService.setStatus(orgId: orgId, emoji: hasStatus ? emoji : nil, text: hasStatus ? text : nil, until: hasStatus ? until : nil,
                                            awayUntil: end, delegateRef: away && !delegate.isEmpty ? delegate : nil, base: base)
            if let p = proxyLoaded, p.enabled != proxyOn || p.useTeammate != proxyTeammate {
                proxyLoaded = try await ChatService.setProxy(orgId: orgId, enabled: proxyOn, useTeammate: proxyTeammate, base: base)
            }
            Haptics.success()
            await store.refresh()
            dismiss()
        } catch { problem = error.localizedDescription }
    }
}

/// "New message": one person for a DM, or up to eight for a group — the
/// same people always open the same conversation.
struct ChatNewMessageSheet: View {
    @ObservedObject var store: ChatStore
    let onOpen: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @State private var picked: [String] = []
    @State private var busy = false

    private var others: [ChatMember] {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        return store.members.filter { !$0.mine && (q.isEmpty || $0.name.lowercased().contains(q) || ($0.title ?? "").lowercased().contains(q)) }
    }

    var body: some View {
        NavigationStack {
            List {
                if !picked.isEmpty {
                    Section {
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 8) {
                                ForEach(picked, id: \.self) { ref in
                                    Button { picked.removeAll { $0 == ref } } label: {
                                        HStack(spacing: 4) {
                                            Text(store.nameOf(ref: ref)).font(.subheadline)
                                            Image(systemName: "xmark").font(.caption2.weight(.bold))
                                        }
                                        .padding(.horizontal, 10).padding(.vertical, 6)
                                        .background(Theme.Colors.textTertiary.opacity(0.15), in: Capsule())
                                    }.buttonStyle(.plain)
                                }
                            }
                        }
                    }
                }
                Section {
                    ForEach(others) { m in
                        Button {
                            if picked.contains(m.ref) { picked.removeAll { $0 == m.ref } }
                            else if picked.count < 8 { picked.append(m.ref) }
                        } label: {
                            HStack(spacing: 10) {
                                ChatAvatar(name: m.name, size: 32, url: m.avatarUrl)
                                VStack(alignment: .leading, spacing: 1) {
                                    Text(m.name).foregroundStyle(Theme.Colors.textPrimary)
                                    if let title = m.title, !title.isEmpty { Text(title).font(.caption).foregroundStyle(Theme.Colors.textSecondary) }
                                }
                                Spacer()
                                Image(systemName: picked.contains(m.ref) ? "checkmark.circle.fill" : "circle")
                                    .foregroundStyle(picked.contains(m.ref) ? Theme.Colors.accent : Theme.Colors.textTertiary)
                            }
                        }
                        .accessibilityAddTraits(picked.contains(m.ref) ? .isSelected : [])
                    }
                }
            }
            .searchable(text: $query, prompt: Text("Find somebody"))
            .navigationTitle("New message").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(picked.count > 1 ? String(localized: "Start a group of \(picked.count + 1)") : String(localized: "Start")) {
                        busy = true
                        Task {
                            defer { busy = false }
                            if picked.count == 1 { onOpen("dm:\(picked[0])"); return }
                            if let view = await store.startGroup(picked) { onOpen(view) }
                        }
                    }
                    .disabled(picked.isEmpty || busy)
                }
            }
        }
    }
}

/// Channels that were archived, newest first. Restoring one puts it back in
/// everyone's sidebar with everything it held.
struct ChatArchivedChannelsView: View {
    @ObservedObject var store: ChatStore
    @State private var channels: [ChatService.ArchivedChannel] = []
    @State private var loaded = false
    @State private var busy: String?
    @State private var problem: String?

    var body: some View {
        List {
            if loaded && channels.isEmpty {
                ContentUnavailableView("No archived channels", systemImage: "archivebox", description: Text("A channel you archive is kept here, ready to come back."))
                    .listRowBackground(Color.clear)
            }
            ForEach(channels) { c in
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(verbatim: c.isPrivate ? "🔒 \(c.name)" : "#\(c.name)")
                        if let when = Self.day(c.archivedAt) {
                            Text(when).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    Spacer()
                    Button {
                        busy = c.slug
                        Task {
                            let failed = await store.unarchiveChannel(c.slug)
                            busy = nil
                            if let failed { problem = failed } else { channels.removeAll { $0.slug == c.slug } }
                        }
                    } label: {
                        if busy == c.slug { ProgressView() } else { Text("Restore") }
                    }
                    .buttonStyle(.bordered)
                    .disabled(busy != nil)
                }
            }
        }
        .listStyle(.plain)
        .navigationTitle("Archived channels")
        .refreshable { await load() }
        .task { await load() }
        .alert("That did not work", isPresented: Binding(get: { problem != nil }, set: { if !$0 { problem = nil } })) {
            Button("OK", role: .cancel) {}
        } message: { Text(verbatim: problem ?? "") }
    }

    private func load() async {
        channels = await store.archivedChannels()
        loaded = true
    }

    private static func day(_ iso: String) -> String? {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let d = f.date(from: iso) ?? ISO8601DateFormatter().date(from: iso) else { return nil }
        return d.formatted(date: .abbreviated, time: .omitted)
    }
}

/// Drafts & sent: what you started writing and left, each in the
/// conversation it waits in, and what you said, newest first.
struct ChatSentView: View {
    @ObservedObject var store: ChatStore
    @State private var tab = 0
    @State private var sent: [ChatMessage] = []
    @State private var loaded = false
    @State private var drafts: [ChatStore.Draft] = []

    var body: some View {
        List {
            Picker("", selection: $tab) {
                Text("Drafts").tag(0)
                Text("Sent").tag(1)
            }
            .pickerStyle(.segmented)
            .listRowSeparator(.hidden)
            if tab == 0 {
                if drafts.isEmpty {
                    ContentUnavailableView("No drafts", systemImage: "square.and.pencil", description: Text("A message you start and leave unsent waits here, in the conversation it was for."))
                        .listRowBackground(Color.clear)
                }
                ForEach(drafts) { d in
                    NavigationLink(value: ChatRoute.conversation(view: d.conversation.view, jump: nil)) {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(verbatim: Self.place(d.conversation)).font(.caption).foregroundStyle(.secondary)
                            Text(verbatim: d.text).font(.subheadline).lineLimit(3)
                        }.padding(.vertical, 4)
                    }
                    .swipeActions {
                        Button(role: .destructive) {
                            store.setDraft(d.conversation.view, "")
                            drafts = store.drafts
                        } label: { Label("Discard", systemImage: "trash") }
                    }
                }
            } else {
                if loaded && sent.isEmpty {
                    ContentUnavailableView("Nothing sent yet", systemImage: "paperplane", description: Text("What you say in a channel, a DM or a thread is listed here."))
                        .listRowBackground(Color.clear)
                }
                ForEach(sent) { m in
                    NavigationLink(value: ChatRoute.conversation(view: m.channel, jump: m.id, thread: m.parentId)) {
                        VStack(alignment: .leading, spacing: 4) {
                            HStack {
                                Text(verbatim: store.conversation(for: m.channel).map(Self.place) ?? "").font(.caption).foregroundStyle(.secondary)
                                if m.parentId != nil { Text("in a thread").font(.caption).foregroundStyle(.secondary) }
                                Spacer()
                                if let at = ChatDates.parse(m.createdAt) {
                                    Text(at.formatted(date: .abbreviated, time: .shortened)).font(.caption).foregroundStyle(.secondary)
                                }
                            }
                            Text(verbatim: m.body).font(.subheadline).lineLimit(3)
                        }.padding(.vertical, 4)
                    }
                }
            }
        }
        .listStyle(.plain)
        .navigationTitle("Drafts & sent")
        .refreshable { await load() }
        .task { await load() }
        .onAppear { drafts = store.drafts }
    }

    private func load() async {
        drafts = store.drafts
        sent = await store.loadSent()
        loaded = true
    }

    private static func place(_ c: ChatConversation) -> String {
        c.kind == .channel && !c.isPrivate ? "#\(c.name)" : c.name
    }
}

/// Search what was said, on a screen of its own: the field at the top, and
/// each match opening where it was said.
struct ChatSearchView: View {
    @ObservedObject var store: ChatStore
    @State private var query = ""
    @State private var results: [ChatMessage] = []

    var body: some View {
        List {
            if query.trimmingCharacters(in: .whitespaces).count >= 2 && results.isEmpty {
                ContentUnavailableView.search(text: query).listRowBackground(Color.clear)
            }
            ForEach(results) { m in
                NavigationLink(value: ChatRoute.conversation(view: m.channel, jump: m.id, thread: m.parentId)) {
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
        .listStyle(.plain)
        .navigationTitle("Search")
        .navigationBarTitleDisplayMode(.inline)
        .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: Text("Search messages"))
        .task(id: query) {
            let q = query
            guard q.trimmingCharacters(in: .whitespaces).count >= 2 else { results = []; return }
            try? await Task.sleep(for: .milliseconds(280))
            guard !Task.isCancelled else { return }
            results = await store.search(q)
        }
    }

    private func place(_ view: String) -> String {
        guard let c = store.conversation(for: view) else { return "" }
        if c.kind == .agent { return "\(c.agent?.glyph ?? ChatAgent.glyph(nil)) \(c.name)" }
        return c.kind == .channel ? (c.isPrivate ? "🔒 \(c.name)" : "#\(c.name)") : c.name
    }
}

/// Catch up, as Slack's app does it: the conversations with something new,
/// one card at a time. Swipe right and it is read; swipe left and it stays
/// unread for later. The buttons underneath do the same, and Open goes in.
struct ChatCatchUpView: View {
    @ObservedObject var store: ChatStore
    @ObservedObject private var translations = ChatTranslations.shared
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// The conversations to get through, taken when the screen opened so a
    /// card never changes under a finger.
    @State private var queue: [String] = []
    @State private var index = 0
    @State private var loaded: [String: [ChatMessage]] = [:]
    @State private var drag: CGSize = .zero
    @State private var read = 0
    @State private var kept = 0
    @State private var started = false

    private let threshold: CGFloat = 110

    var body: some View {
        VStack(spacing: 16) {
            if started && index >= queue.count {
                finished
            } else if let view = current {
                Text(verbatim: "\(index + 1) / \(queue.count)")
                    .font(.footnote.weight(.semibold)).foregroundStyle(Theme.Colors.textSecondary)
                ZStack {
                    if index + 1 < queue.count {
                        card(queue[index + 1])
                            .scaleEffect(0.95).offset(y: 14).opacity(0.6)
                            .allowsHitTesting(false)
                    }
                    card(view)
                        .overlay(alignment: .topLeading) { stamp(String(localized: "Read"), color: Theme.Colors.approve, on: drag.width > 30) }
                        .overlay(alignment: .topTrailing) { stamp(String(localized: "Keep unread"), color: Theme.Colors.textSecondary, on: drag.width < -30) }
                        .offset(x: drag.width, y: drag.height * 0.2)
                        .rotationEffect(.degrees(reduceMotion ? 0 : Double(drag.width / 22)))
                        .gesture(
                            DragGesture()
                                .onChanged { drag = $0.translation }
                                .onEnded { value in
                                    if value.translation.width > threshold { decide(markRead: true) }
                                    else if value.translation.width < -threshold { decide(markRead: false) }
                                    else { withAnimation(.spring(response: 0.35, dampingFraction: 0.75)) { drag = .zero } }
                                }
                        )
                        .accessibilityAction(named: Text("Mark as read")) { decide(markRead: true) }
                        .accessibilityAction(named: Text("Keep unread")) { decide(markRead: false) }
                }
                .frame(maxHeight: .infinity)
                HStack(spacing: 14) {
                    Button { decide(markRead: false) } label: {
                        Label("Keep unread", systemImage: "arrow.uturn.left").frame(maxWidth: .infinity, minHeight: 48)
                    }
                    .buttonStyle(.plain).foregroundStyle(Theme.Colors.textPrimary)
                    .background(Theme.Colors.surfaceRaised, in: Capsule())
                    .accessibilityIdentifier("catchup.keep")
                    NavigationLink(value: ChatRoute.conversation(view: view, jump: nil)) {
                        Image(systemName: "arrow.up.right").font(.system(size: 17, weight: .semibold))
                            .frame(width: 48, height: 48)
                    }
                    .buttonStyle(.plain).foregroundStyle(Theme.Colors.textPrimary)
                    .background(Theme.Colors.surfaceRaised, in: Circle())
                    .accessibilityLabel("Open")
                    Button { decide(markRead: true) } label: {
                        Label("Mark as read", systemImage: "checkmark").frame(maxWidth: .infinity, minHeight: 48)
                    }
                    .buttonStyle(.plain).foregroundStyle(Theme.Colors.ctaText)
                    .background(Theme.Colors.ctaFill, in: Capsule())
                    .accessibilityIdentifier("catchup.read")
                }
                .font(.subheadline.weight(.semibold))
                Text("Swipe right to mark read, left to keep it unread.")
                    .font(.caption).foregroundStyle(Theme.Colors.textTertiary)
            } else {
                ProgressView().frame(maxHeight: .infinity)
            }
        }
        .padding(.horizontal, 20).padding(.vertical, 12)
        .background(Theme.Colors.surface)
        .navigationTitle("Catch up")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            guard !started else { return }
            // Where someone named you first, then the rest as the list has them.
            let fresh = store.freshViews
            queue = fresh.filter { store.mentions(in: $0) > 0 } + fresh.filter { store.mentions(in: $0) == 0 }
            started = true
            await prefetch()
        }
    }

    private var current: String? { index < queue.count ? queue[index] : nil }

    private var finished: some View {
        VStack(spacing: 14) {
            Spacer()
            Image(systemName: "checkmark.circle").font(.system(size: 48, weight: .light)).foregroundStyle(Theme.Colors.approve)
            Text("Nothing left to catch up on").font(.title3.weight(.semibold))
            if read + kept > 0 {
                Text("\(read) read, \(kept) kept unread").font(.subheadline).foregroundStyle(Theme.Colors.textSecondary)
            }
            Button("Done") { dismiss() }.buttonStyle(.borderedProminent).padding(.top, 6)
            Spacer()
        }
    }

    private func stamp(_ text: String, color: Color, on: Bool) -> some View {
        Text(verbatim: text)
            .font(.headline.weight(.heavy)).textCase(.uppercase)
            .foregroundStyle(color)
            .padding(.horizontal, 12).padding(.vertical, 6)
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(color, lineWidth: 2))
            .rotationEffect(.degrees(on ? -8 : 0))
            .padding(20)
            .opacity(on ? min(1, Double(abs(drag.width) - 30) / 80) : 0)
    }

    /// One conversation: where it is, how much is new, and what was said
    /// since you last read it.
    private func card(_ view: String) -> some View {
        let c = store.conversation(for: view)
        let since = store.readAt(view) ?? ""
        let all = (loaded[view] ?? []).filter { $0.parentId == nil && !($0.deleted ?? false) }
        let new = all.filter { !$0.mine && $0.createdAt > since }
        let shown = Array((new.isEmpty ? all : new).suffix(6))
        let mentions = store.mentions(in: view)
        return VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 10) {
                if let c, c.kind == .channel {
                    Image(systemName: c.isPrivate ? "lock" : "number").font(.system(size: 18, weight: .bold))
                        .frame(width: 36, height: 36).background(Theme.Colors.textTertiary.opacity(0.15), in: RoundedRectangle(cornerRadius: 9))
                } else if let c {
                    ChatAvatar(name: c.name, size: 36, agentEmoji: c.kind == .agent ? (c.agent?.glyph ?? ChatAgent.glyph(nil)) : nil, url: c.kind == .agent ? c.agent?.avatarUrl : c.member?.avatarUrl)
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text(verbatim: c?.name ?? "").font(.headline).lineLimit(1)
                    HStack(spacing: 6) {
                        if !new.isEmpty { Text("\(new.count) new").font(.caption).foregroundStyle(Theme.Colors.textSecondary) }
                        if mentions > 0 {
                            Text("@ \(mentions)").font(.caption.weight(.bold)).foregroundStyle(.white)
                                .padding(.horizontal, 6).padding(.vertical, 1).background(Theme.Colors.reject, in: Capsule())
                        }
                    }
                }
                Spacer(minLength: 0)
            }
            Divider()
            if loaded[view] == nil {
                ChatSkeletonMessages(count: 4).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 12) {
                        ForEach(shown) { m in
                            HStack(alignment: .top, spacing: 10) {
                                ChatAvatar(name: m.authorName ?? "?", size: 28, url: m.authorAvatar)
                                VStack(alignment: .leading, spacing: 2) {
                                    HStack(spacing: 6) {
                                        Text(verbatim: m.isAI ? String(localized: "Your AI") : (m.authorName ?? "")).font(.subheadline.weight(.semibold))
                                        Text(m.date, style: .time).font(.caption2).foregroundStyle(Theme.Colors.textTertiary)
                                    }
                                    Text(verbatim: translations.shown(m).text).font(.subheadline).lineLimit(5)
                                }
                            }
                        }
                        if shown.isEmpty {
                            Text("Nothing new to show here.").font(.subheadline).foregroundStyle(Theme.Colors.textSecondary)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .scrollDisabled(shown.count < 4)
            }
        }
        .padding(18)
        .frame(maxWidth: .infinity, maxHeight: 480, alignment: .top)
        .background(Theme.Colors.surfaceRaised, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous).stroke(Theme.Colors.border, lineWidth: 1))
        .shadow(color: .black.opacity(0.18), radius: 16, y: 6)
    }

    private func decide(markRead: Bool) {
        guard let view = current else { return }
        Haptics.light()
        if markRead { read += 1; Task { await store.markRead(view) } } else { kept += 1 }
        let out: CGFloat = markRead ? 600 : -600
        withAnimation(.easeIn(duration: reduceMotion ? 0.1 : 0.22)) { drag = CGSize(width: out, height: drag.height) }
        Task {
            try? await Task.sleep(for: .milliseconds(reduceMotion ? 110 : 230))
            drag = .zero
            index += 1
            if index >= queue.count { Haptics.success() }
            await prefetch()
        }
    }

    /// The card on screen and the one behind it, loaded ahead.
    private func prefetch() async {
        for view in queue.dropFirst(index).prefix(2) where loaded[view] == nil {
            loaded[view] = await store.peek(view)
        }
    }
}

/// Pictures and videos picked from the camera roll, made JPEGs and mp4s (a
/// HEIC or an HEVC .mov would not show everywhere) and uploaded to the
/// conversation they are for.
enum ChatPhotos {
    /// How many files one message carries; the Worker refuses a send with more.
    static let maxPerMessage = 10

    /// How many more can be picked for a message holding `attached` files
    /// with `uploading` more on their way up. Those going up keep their
    /// places, so picking again before they arrive cannot add up to more.
    static func room(attached: Int, uploading: Int) -> Int {
        max(0, maxPerMessage - attached - uploading)
    }

    /// The long side a photo is sent at: plenty to read on a phone or a
    /// laptop, a fraction of the bytes of a camera's full twelve megapixels
    /// or more — which is what made a photo slow to go up.
    static let maxPixels = 2560

    /// A picked photo made ready to send: no larger than `maxPixels` on its
    /// long side, upright, as a JPEG (a HEIC would not show everywhere).
    /// Read straight from the file at that size, so a full-size image is
    /// never decoded; done off the main thread by `upload`.
    static func prepared(_ data: Data) -> (jpeg: Data, width: Int, height: Int)? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixels,
        ]
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary),
              let jpeg = UIImage(cgImage: image).jpegData(compressionQuality: 0.85) else { return nil }
        return (jpeg, image.width, image.height)
    }

    /// The largest file the Worker keeps (MAX_FILE_BYTES).
    static let maxBytes = 25 * 1024 * 1024

    /// The sizes a video is tried at, largest first: the first whose file
    /// fits under `maxBytes` is sent. A minute or so goes at 720p, a few
    /// minutes only smaller.
    static let videoPresets = [AVAssetExportPreset1280x720, AVAssetExportPreset960x540, AVAssetExportPreset640x480]

    /// A picked video made ready to send: an mp4 no larger than `maxBytes`,
    /// with the shape it is seen at. Nil when even the smallest size is too
    /// large, or it cannot be read. Done off the main thread by `upload`.
    static func preparedVideo(_ source: URL) async -> (mp4: Data, width: Int, height: Int)? {
        let asset = AVURLAsset(url: source)
        guard let track = try? await asset.loadTracks(withMediaType: .video).first,
              let look = try? await track.load(.naturalSize, .preferredTransform) else { return nil }
        // Upright: a phone held up records sideways and says so in the transform.
        let shown = CGRect(origin: .zero, size: look.0).applying(look.1).size
        for preset in videoPresets {
            let target = FileManager.default.temporaryDirectory.appendingPathComponent("video-\(UUID().uuidString).mp4")
            guard await MediaStore.export(source, preset: preset, to: target) else { continue }
            defer { try? FileManager.default.removeItem(at: target) }
            let bytes = (try? FileManager.default.attributesOfItem(atPath: target.path))?[.size] as? Int
            if let bytes, bytes <= maxBytes, let mp4 = try? Data(contentsOf: target) {
                return (mp4, Int(abs(shown.width).rounded()), Int(abs(shown.height).rounded()))
            }
        }
        return nil
    }

    /// Whether a picked item is a video rather than a picture.
    static func isVideo(_ item: PhotosPickerItem) -> Bool {
        item.supportedContentTypes.contains { $0.conforms(to: .movie) }
    }

    /// Picked photos and videos, each made ready and uploaded at the same
    /// time rather than one after another; the files come back in the order
    /// picked.
    @MainActor
    static func upload(_ items: [PhotosPickerItem], origin: ChatStore.MediaScope, store: ChatStore) async -> [ChatFile] {
        let stamp = Int(Date().timeIntervalSince1970)
        return await withTaskGroup(of: (Int, ChatFile?).self) { group in
            for (i, item) in items.enumerated() {
                group.addTask { @MainActor in
                    guard store.isCurrent(origin) else { return (i, nil) }
                    if ChatPhotos.isVideo(item) {
                        guard let picked = try? await item.loadTransferable(type: PickedVideo.self) else { return (i, nil) }
                        defer { try? FileManager.default.removeItem(at: picked.url) }
                        guard let video = await ChatPhotos.preparedVideo(picked.url) else {
                            if store.isCurrent(origin) { store.error = String(localized: "That video is too long to send. A file can be at most 25 MB.") }
                            return (i, nil)
                        }
                        let name = "video-\(stamp)-\(i + 1).mp4"
                        return (i, await store.upload(origin, data: video.mp4, type: "video/mp4", name: name, width: video.width, height: video.height))
                    }
                    guard let data = try? await item.loadTransferable(type: Data.self) else { return (i, nil) }
                    let ready = await Task.detached(priority: .userInitiated) { ChatPhotos.prepared(data) }.value
                    guard let photo = ready else { return (i, nil) }
                    let name = "photo-\(stamp)-\(i + 1).jpg"
                    return (i, await store.upload(origin, data: photo.jpeg, type: "image/jpeg", name: name, width: photo.width, height: photo.height))
                }
            }
            var done: [(Int, ChatFile)] = []
            for await (i, file) in group { if let file { done.append((i, file)) } }
            return done.sorted { $0.0 < $1.0 }.map(\.1)
        }
    }
}

/// A video picked from the camera roll, as a copy in the temporary
/// directory: a phone's video can be far too large to hold in memory, and
/// the file the picker hands over is gone once it returns.
struct PickedVideo: Transferable {
    let url: URL
    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(contentType: .movie) { video in
            SentTransferredFile(video.url)
        } importing: { received in
            let ext = received.file.pathExtension.isEmpty ? "mov" : received.file.pathExtension
            let copy = FileManager.default.temporaryDirectory.appendingPathComponent("picked-\(UUID().uuidString).\(ext)")
            try FileManager.default.copyItem(at: received.file, to: copy)
            return PickedVideo(url: copy)
        }
    }
}

/// A guest invite for one channel, made: the link to hand over, and what
/// it lets in — that channel, nothing else in the workspace.
struct ChatGuestInviteSheet: View {
    let invite: MintedInvite
    let channel: String
    @Environment(\.dismiss) private var dismiss
    @State private var copied = false

    var body: some View {
        NavigationStack {
            List {
                Section {
                    if let raw = invite.link, let url = URL(string: raw) {
                        Text(verbatim: raw).font(.footnote.monospaced()).textSelection(.enabled).lineLimit(3)
                        ShareLink(item: url, message: Text("Join #\(channel) on Honmaru AI")) { Label("Share", systemImage: "square.and.arrow.up") }
                        Button {
                            UIPasteboard.general.string = raw
                            copied = true
                        } label: { Label(copied ? LocalizedStringKey("Copied") : LocalizedStringKey("Copy link"), systemImage: copied ? "checkmark" : "doc.on.doc") }
                    } else {
                        Text(verbatim: invite.code).font(.footnote.monospaced()).textSelection(.enabled)
                    }
                } footer: {
                    Text("Anyone who opens this link within three days joins as a guest of #\(channel), and sees nothing else in the workspace.")
                }
            }
            .navigationTitle("Invite a guest").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
        .presentationDetents([.medium])
    }
}

/// What is attached to the reply about to be sent: each with a way to take
/// it off, and a spinner while more are on their way up.
struct ChatAttachedStrip: View {
    @ObservedObject var store: ChatStore
    @Binding var attached: [ChatFile]
    let uploading: Int
    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(attached) { f in
                    ZStack(alignment: .topTrailing) {
                        if f.isPicture, let url = store.baseURL.flatMap({ f.address(base: $0) }) {
                            AsyncImage(url: url) { image in image.resizable().scaledToFill() } placeholder: { Theme.Colors.surfaceRaised }
                                .frame(width: 56, height: 56).clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                        } else {
                            Image(systemName: f.type.hasPrefix("video/") ? "film" : "doc").frame(width: 56, height: 56)
                                .background(Theme.Colors.surfaceRaised, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                        }
                        Button { attached.removeAll { $0.id == f.id } } label: {
                            Image(systemName: "xmark.circle.fill").font(.system(size: 18)).symbolRenderingMode(.palette)
                                .foregroundStyle(.white, .black.opacity(0.6))
                        }.offset(x: 6, y: -6).accessibilityLabel(Text("Remove \(f.name)"))
                    }
                }
                if uploading > 0 { ProgressView().frame(width: 56, height: 56) }
            }.padding(.horizontal, 4).padding(.top, 6)
        }
    }
}

/// A bounded source lookup, read separately from the thread's contiguous history.
private struct ChatThreadReferenceSheet: View {
    let message: ChatMessage
    let onClose: () -> Void
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    Text(verbatim: message.authorName ?? "Someone").font(.headline)
                    Text(message.date, style: .date).font(.caption).foregroundStyle(Theme.Colors.textSecondary)
                    Text(ChatText.attributed(message.body)).textSelection(.enabled)
                    if let quote = message.replyTo {
                        Text(quote.deleted ? String(localized: "Original message was deleted") : quote.excerpt).font(.footnote).foregroundStyle(Theme.Colors.textSecondary)
                    }
                    ForEach(message.files ?? []) { file in Label(file.name, systemImage: "paperclip") }
                }.frame(maxWidth: .infinity, alignment: .leading).padding()
            }
            .navigationTitle("Linked reply").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarTrailing) { CloseButton { onClose() } } }
        }
        .presentationDetents([.medium, .large])
    }
}

/// The open thread, read as it is seen: a reply arriving while the newest
/// is in view, coming back down to the newest, and coming back to the app
/// with the thread open (ChatStore.readOpenThread). Apart from the sheet's
/// body, which is already as much as the compiler will check at once.
private struct ReadsOpenThread: ViewModifier {
    @ObservedObject var store: ChatStore
    let atBottom: Bool
    @Environment(\.scenePhase) private var scenePhase

    private func read() {
        guard atBottom, scenePhase == .active, store.threadReference == nil, !store.threadReferenceLoading, store.threadJump == nil else { return }
        let target = store.thread?.parent.id
        let presentation = store.threadPresentation
        Task {
            guard !Task.isCancelled, atBottom, store.threadPresentation == presentation, store.thread?.parent.id == target else { return }
            await store.readOpenThread()
        }
    }

    func body(content: Content) -> some View {
        content
            .onAppear { read() }
            .onChange(of: store.threadReference?.id) { _, _ in read() }
            .onChange(of: store.threadReferenceLoading) { _, _ in read() }
            .onChange(of: store.thread?.parent.id) { _, _ in read() }
            .onChange(of: store.threadLoading) { _, _ in read() }
            .onChange(of: store.thread?.replies.count ?? 0) { _, _ in read() }
            .onChange(of: atBottom) { _, _ in read() }
            .onChange(of: scenePhase) { _, _ in read() }
    }
}
