import PhotosUI
import SwiftUI
import UIKit

enum ChatRoute: Hashable {
    case conversation(view: String, jump: String?)
    case activity
    case later
    case threads
    /// The team's agents: "@hayao" and the rest.
    case agents
    /// Channels that were archived, each with a way back.
    case archived
    /// Drafts & sent: what you are still writing, and what you said.
    case sent
    /// Every message you can read, searched.
    case search
    /// Slack's Catch up: one unread conversation at a time, swiped right to
    /// mark it read or left to keep it for later.
    case catchUp
}

/// One conversation, the way a chat app on a phone draws it: messages you
/// long-press for everything Slack lets you do, a floating glass composer,
/// threads in a sheet, and the AI's steps while it makes a card.
struct ConversationView: View {
    let view: String
    var jump: String?
    @EnvironmentObject private var appState: AppState
    @ObservedObject var store: ChatStore

    @State private var draft = ""
    /// What was being written when an edit began: back in the box when the
    /// edit is done or cancelled. An edit's words are never kept as a draft.
    @State private var keptDraft: String?
    /// The last send refused or held back (a data rule): its words are back in the box, and
    /// sending the same words again reuses its id, so a send that in fact
    /// landed is not posted twice.
    @State private var unsent: (text: String, clientId: String)?
    @FocusState private var focused: Bool
    @State private var editing: ChatMessage?
    /// The message the next one answers, inline (swiped, or Reply).
    @State private var replyingTo: ChatMessage?
    /// A reply's quote pressed: the message it quotes, to scroll to.
    @State private var quoteJump: String?
    @State private var confirmDelete: ChatMessage?
    @State private var reactingTo: ChatMessage?
    @State private var showThread = false
    @State private var showPins = false
    @State private var pins: [ChatMessage] = []
    @State private var profileRef: String?
    @State private var openCard: DecisionCard?
    @State private var clip: [ChatMessage] = []
    @State private var notes: [String] = []
    @State private var customTime = false
    @State private var customDate = Date().addingTimeInterval(3600)
    @State private var showScheduled = false
    @State private var newSince: String?
    @State private var highlight: String?
    @State private var photoItems: [PhotosPickerItem] = []
    @State private var attached: [ChatFile] = []
    @State private var uploading = 0
    @State private var jamOpen = false
    @State private var forwarding: ChatMessage?
    @State private var newSectionName = ""
    @State private var askingSectionName = false
    @State private var canvasOpen = false
    @State private var agentsOpen = false
    @State private var recordOpen = false

    private var conversation: ChatConversation? { store.conversation(for: view) }
    private var title: String {
        guard let c = conversation else { return "" }
        if c.kind == .channel { return c.isPrivate ? "🔒 \(c.name)" : "#\(c.name)" }
        if c.kind == .agent { return "\(c.agent?.glyph ?? ChatAgent.glyph(nil)) \(c.name)" }
        return c.name
    }
    /// Your own conversation with one of the team's agents.
    private var isAgentConversation: Bool { view.hasPrefix("ag:") }
    private var list: [ChatMessage] { store.messages[view] ?? [] }
    private var here: [ChatScheduled] { store.scheduled.filter { $0.channel == view } }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    if store.more[view] == true {
                        ProgressView().frame(maxWidth: .infinity).padding()
                            .onAppear { Task { await store.loadOlder(view) } }
                    } else {
                        start
                    }
                    rows
                    ForEach(Array(notes.enumerated()), id: \.offset) { _, n in
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            Image(systemName: "eye.slash").font(.caption).foregroundStyle(Theme.Colors.textTertiary)
                            Text(n).font(.footnote).foregroundStyle(Theme.Colors.textSecondary)
                        }
                        .padding(10).frame(maxWidth: .infinity, alignment: .leading)
                        .background(Theme.Colors.surface, in: RoundedRectangle(cornerRadius: 12))
                        .padding(.horizontal, 16).padding(.vertical, 4)
                        .accessibilityLabel(Text("Only visible to you. \(n)"))
                    }
                    if let step = store.thinking[view] { ChatAISteps(step: step).padding(.vertical, 6) }
                    ForEach((store.agentTyping[view] ?? []).filter { $0.parentId == nil || !isAgentConversation }, id: \.agent.id) { typing in
                        ChatAgentTypingRow(agent: typing.agent).padding(.vertical, 6)
                    }
                    Color.clear.frame(height: 1).id("bottom")
                }
                .padding(.bottom, 8)
            }
            .scrollDismissesKeyboard(.interactively)
            .defaultScrollAnchor(.bottom)
            .modifier(ChatStaysAtBottom())
            .onChange(of: list.count) { _, _ in if jump == nil { withAnimation { proxy.scrollTo("bottom", anchor: .bottom) } } }
            .onChange(of: store.thinking[view]) { _, _ in withAnimation { proxy.scrollTo("bottom", anchor: .bottom) } }
            .onChange(of: store.agentTyping[view]) { _, _ in withAnimation { proxy.scrollTo("bottom", anchor: .bottom) } }
            .onChange(of: quoteJump) { _, id in
                guard let id else { return }
                quoteJump = nil
                guard list.contains(where: { $0.id == id }) else { return }
                highlight = id
                withAnimation { proxy.scrollTo(id, anchor: .center) }
                Task {
                    try? await Task.sleep(for: .seconds(1.6))
                    if highlight == id { withAnimation { highlight = nil } }
                }
            }
            .task(id: view) {
                replyingTo = nil
                newSince = store.reads[view]
                draft = store.draft(view)
                await store.open(view)
                if let jump {
                    highlight = jump
                    try? await Task.sleep(for: .milliseconds(250))
                    withAnimation { proxy.scrollTo(jump, anchor: .center) }
                    try? await Task.sleep(for: .seconds(1.6))
                    withAnimation { highlight = nil }
                } else {
                    proxy.scrollTo("bottom", anchor: .bottom)
                    // Rows are measured as they are drawn, and what loads a
                    // moment later (pictures, translations) pushed the newest
                    // message down out of sight: once more when it settles.
                    try? await Task.sleep(for: .milliseconds(350))
                    if !Task.isCancelled { proxy.scrollTo("bottom", anchor: .bottom) }
                }
            }
            .safeAreaInset(edge: .bottom, spacing: 0) { bottomBar }
            .safeAreaInset(edge: .top, spacing: 0) { ChatBookmarksStrip(view: view).environmentObject(appState) }
        }
        .background(Theme.Colors.background)
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { toolbar }
        .onChange(of: draft) { old, text in
            // A new line in a quote or a list carries its mark on; a new line
            // on an empty marked line ends it — as on the web.
            if let carried = ChatFormat.continued(old: old, new: text), carried != text { draft = carried; return }
            if editing == nil { store.setDraft(view, text) }
        }
        .sheet(item: $reactingTo) { m in ChatEmojiPicker { e in Task { await store.react(m, e) } } }
        .sheet(isPresented: $showThread) { ChatThreadSheet(store: store, onOpenCard: open(card:)) }
        .sheet(isPresented: $showPins) { pinsSheet }
        .sheet(isPresented: $canvasOpen) { ChatCanvasSheet(view: view, title: title).environmentObject(appState) }
        .sheet(isPresented: $agentsOpen) { ChatChannelAgentsSheet(store: store, view: view, title: title) }
        .sheet(isPresented: $recordOpen) { ChannelRecordSheet(view: view, title: title).environmentObject(appState) }
        .sheet(item: Binding(get: { profileRef.map { IdentifiedRef(ref: $0) } }, set: { profileRef = $0?.ref })) { r in
            ChatProfileSheet(store: store, ref: r.ref)
        }
        .sheet(item: $openCard) { card in
            // Whoever may take it back does it here too, as on the feed.
            let me = appState.currentUser?.id ?? ""
            CardDetailSheet(card: card, onDelete: card.canBeDeleted(by: me) ? {
                Task { try? await appState.cardService.delete(cardID: card.id, actorUserID: me) }
            } : nil).environmentObject(appState)
        }
        .sheet(isPresented: $customTime) { customTimeSheet }
        .sheet(item: $forwarding) { m in ChatForwardSheet(store: store, message: m) }
        .modifier(DataRuleAlerts(store: store) { draft = ""; attached = []; unsent = nil })
        .alert("New section", isPresented: $askingSectionName) {
            TextField("Section name", text: $newSectionName)
            Button("Create") {
                let name = newSectionName.trimmingCharacters(in: .whitespaces)
                newSectionName = ""
                guard !name.isEmpty else { return }
                Task { await store.newSection(name, with: view) }
            }
            Button("Cancel", role: .cancel) { newSectionName = "" }
        }
        .fullScreenCover(isPresented: $jamOpen) {
            ChatJamSheet(view: view, title: title, base: store.baseURL, orgId: appState.currentUser?.teamID)
        }
        .confirmationDialog(LocalizedStringKey((confirmDelete?.replyCount ?? 0) > 0 && confirmDelete?.parentId == nil
                            ? "Delete this message and its thread? Replies from others will be deleted too. This cannot be undone."
                            : "Delete this message? This cannot be undone."), isPresented: Binding(get: { confirmDelete != nil }, set: { if !$0 { confirmDelete = nil } }), titleVisibility: .visible) {
            Button("Delete message", role: .destructive) { if let m = confirmDelete { Task { await store.delete(m) } }; confirmDelete = nil }
        }
    }

    // MARK: Messages

    private var start: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let c = conversation {
                if c.kind == .channel {
                    Image(systemName: "number").font(.title2.weight(.bold)).frame(width: 48, height: 48).glassPanel(cornerRadius: 14)
                    Text("This is the start of #\(c.name)").font(.title3.weight(.bold))
                    Text("Talk about \(c.name) here. Write @AI to ask your AI anything. A decision card is made only when you ask for one: Send as a decision, or long-press a message and pick Make it a decision.")
                        .font(.subheadline).foregroundStyle(Theme.Colors.textSecondary)
                } else if c.kind == .agent {
                    ChatAvatar(name: c.name, size: 48, agentEmoji: c.agent?.glyph ?? ChatAgent.glyph(nil), url: c.agent?.avatarUrl)
                    Text(c.name).font(.title3.weight(.bold))
                    if let d = c.agent?.description, !d.isEmpty {
                        Text(verbatim: d).font(.subheadline).foregroundStyle(Theme.Colors.textSecondary)
                    }
                    Text("Only you see this conversation. Just write — \(c.name) reads what you say here and answers right below.")
                        .font(.subheadline).foregroundStyle(Theme.Colors.textSecondary)
                } else {
                    ChatAvatar(name: c.name, size: 48, url: c.member?.avatarUrl)
                    Text(c.name).font(.title3.weight(.bold))
                    Text("Just the two of you. Write @AI to ask your AI, or Send as a decision to send \(c.name) a decision.")
                        .font(.subheadline).foregroundStyle(Theme.Colors.textSecondary)
                }
            }
        }.padding(16).padding(.top, 8)
    }

    @ViewBuilder
    private var rows: some View {
        let items = list
        let since = newSince ?? ""
        let firstNew = items.firstIndex { !$0.mine && !since.isEmpty && $0.createdAt > since }
        ForEach(Array(items.enumerated()), id: \.element.id) { index, m in
            let previous = index > 0 ? items[index - 1] : nil
            if previous == nil || !Calendar.current.isDate(previous!.date, inSameDayAs: m.date) {
                ChatDayDivider(date: m.date)
            }
            if index == firstNew { ChatNewLine() }
            if m.kind == "joined" {
                ChatJoinedRow(message: m).id(m.id)
            } else {
            // A reply always shows whose it is, under the line it quotes.
            let joined = previous.map { $0.authorRef == m.authorRef && $0.kind == m.kind && m.date.timeIntervalSince($0.date) < 300 && Calendar.current.isDate($0.date, inSameDayAs: m.date) && m.pinned != true && m.replyTo == nil } ?? false
            ChatMessageRow(
                message: m, joined: joined, highlighted: highlight == m.id,
                nameOf: store.nameOf(ref:),
                onReact: { e in Task { await store.react(m, e) } },
                onAddReaction: { reactingTo = m },
                onOpenThread: { Task { await store.openThread(m) }; showThread = true },
                onOpenCard: open(card:),
                onProfile: { profileRef = $0 },
                onOpenQuote: { quoteJump = $0 }
            )
            .modifier(ChatSendState(message: m))
            // Swiped to the left: answered, as in Discord (#237).
            .modifier(ChatSwipeToReply(enabled: !m.isDeleted && !m.id.hasPrefix("tmp-")) { startReply(m) })
            .id(m.id)
            .overlay(alignment: .topTrailing) {
                if clip.contains(where: { $0.id == m.id }) {
                    Image(systemName: "paperclip.circle.fill").font(.title3).foregroundStyle(Theme.Colors.accent).padding(8)
                }
            }
            // Not the server's yet: nothing to react to, edit or link.
            .contextMenu { if !m.isDeleted && !m.id.hasPrefix("tmp-") { menu(for: m) } }
            }
        }
    }

    @ViewBuilder
    private func menu(for m: ChatMessage) -> some View {
        ControlGroup {
            ForEach(["✅", "👀", "🙌"], id: \.self) { e in
                Button(e) { Task { await store.react(m, e) } }
            }
            Button { reactingTo = m } label: { Image(systemName: "face.smiling") }
        }
        Button { startReply(m) } label: { Label("Reply", systemImage: "arrowshape.turn.up.left") }
        Button { Task { await store.openThread(m) }; showThread = true } label: { Label("Reply in thread", systemImage: "bubble.left.and.bubble.right") }
        if m.mine && m.kind == "message" {
            Button { beginEdit(m) } label: { Label("Edit message", systemImage: "pencil") }
        }
        Button { UIPasteboard.general.string = m.body } label: { Label("Copy text", systemImage: "doc.on.doc") }
        Button {
            Task { if let url = await store.messageLink(m) { UIPasteboard.general.url = url; UIPasteboard.general.string = url.absoluteString } }
        } label: { Label("Copy link", systemImage: "link") }
        Button { forwarding = m } label: { Label("Forward", systemImage: "arrowshape.turn.up.right") }
        if !m.mine {
            Button { Task { await store.markUnread(m) } } label: { Label("Mark unread", systemImage: "envelope.badge") }
        }
        if m.mine, m.previewsHidden != true, ChatLinkMetadata.firstLink(in: m.body) != nil {
            Button { Task { await store.hidePreviews(m) } } label: { Label("Remove preview", systemImage: "xmark.rectangle") }
        }
        Button { Task { await store.togglePin(m) } } label: {
            Label(m.pinned == true ? LocalizedStringKey("Unpin") : LocalizedStringKey("Pin to channel"), systemImage: m.pinned == true ? "pin.slash" : "pin")
        }
        Menu {
            Button("Save for later") { Task { await store.saveForLater(m, remindAt: nil) } }
            Button("Remind me in 1 hour") { Task { await store.saveForLater(m, remindAt: .now.addingTimeInterval(3600)) } }
            Button("Remind me tomorrow at 9:00") { Task { await store.saveForLater(m, remindAt: ChatTimes.tomorrow(at: 9)) } }
        } label: { Label("Save for later", systemImage: "bookmark") }
        Button {
            if clip.contains(where: { $0.id == m.id }) { clip.removeAll { $0.id == m.id } } else { clip.append(m) }
        } label: {
            Label(clip.contains(where: { $0.id == m.id }) ? LocalizedStringKey("Remove from clip") : LocalizedStringKey("Add to clip"), systemImage: "paperclip")
        }
        if m.cardId == nil && m.kind == "message" {
            Button { Task { await store.decide(m) } } label: { Label("Make it a decision", systemImage: "sparkles") }
        }
        if m.mine && m.kind == "message" {
            Divider()
            Button(role: .destructive) { confirmDelete = m } label: { Label("Delete message", systemImage: "trash") }
        }
    }

    // MARK: The bottom: clip tray, scheduled, the composer

    private var bottomBar: some View {
        VStack(spacing: 8) {
            if !clip.isEmpty {
                HStack(spacing: 10) {
                    Label("\(clip.count) messages clipped", systemImage: "paperclip").font(.footnote.weight(.semibold))
                    Spacer()
                    Button("Clear") { clip = [] }.font(.footnote)
                    Button("Make one decision") {
                        let items = clip, text = draft
                        Task { if await store.clip(view, items: items, instruction: text) { clip = []; draft = "" } }
                    }.font(.footnote.weight(.bold)).buttonStyle(.borderedProminent).tint(Theme.Colors.accent)
                }
                .padding(.horizontal, 14).padding(.vertical, 10)
                .glassPanel(cornerRadius: 18)
            }
            if !here.isEmpty {
                DisclosureGroup(isExpanded: $showScheduled) {
                    ForEach(here) { s in
                        HStack(alignment: .firstTextBaseline) {
                            if let at = ChatDates.parse(s.sendAt) {
                                Text(at, format: .dateTime.weekday(.abbreviated).hour().minute()).font(.caption).foregroundStyle(Theme.Colors.textSecondary)
                            }
                            Text(s.body).font(.footnote).lineLimit(1)
                            Spacer()
                            Button("Edit") { draft = s.body; Task { await store.cancelScheduled(s) } }.font(.caption)
                            Button("Cancel", role: .destructive) { Task { await store.cancelScheduled(s) } }.font(.caption)
                        }.padding(.top, 6)
                    }
                } label: {
                    Label(here.count == 1 ? String(localized: "1 scheduled message") : String(localized: "\(here.count) scheduled messages"), systemImage: "clock")
                        .font(.footnote.weight(.semibold))
                }
                .padding(.horizontal, 14).padding(.vertical, 10)
                .glassPanel(cornerRadius: 18)
            }
            if let editing {
                HStack {
                    Label("Editing", systemImage: "pencil").font(.caption.weight(.semibold)).foregroundStyle(.orange)
                    Text(editing.body).font(.caption).lineLimit(1).foregroundStyle(Theme.Colors.textSecondary)
                    Spacer()
                    Button("Cancel") { endEdit() }.font(.caption)
                }.padding(.horizontal, 14)
            } else if let quote = replyQuote {
                ChatReplyingBar(quote: quote, nameOf: store.nameOf(ref:)) { replyingTo = nil }
            }
            slashSuggestions
            mentionSuggestions
            mentionCheck
            composer
        }
        .padding(.horizontal, 12)
        .padding(.top, 6)
        .padding(.bottom, 8)
        .animation(.snappy, value: clip.count)
        .animation(.snappy, value: here.count)
    }

    private var placeholder: String {
        guard let c = conversation else { return "" }
        return c.kind == .channel ? String(localized: "Message #\(c.name)") : String(localized: "Message \(c.name)")
    }

    private var composer: some View {
        GlassGroup(spacing: 10) {
            VStack(alignment: .leading, spacing: 6) {
                if !attached.isEmpty || uploading > 0 {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 8) {
                            ForEach(attached) { f in
                                ZStack(alignment: .topTrailing) {
                                    if f.isPicture, let url = store.baseURL.flatMap({ f.address(base: $0) }) {
                                        AsyncImage(url: url) { image in image.resizable().scaledToFill() } placeholder: { Theme.Colors.surfaceRaised }
                                            .frame(width: 56, height: 56).clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                                    } else {
                                        Image(systemName: "doc").frame(width: 56, height: 56)
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
                HStack(alignment: .bottom, spacing: 8) {
                    // Photos from the camera roll, uploaded as soon as they are picked.
                    PhotosPicker(selection: $photoItems, maxSelectionCount: 10, matching: .images) {
                        Image(systemName: "plus").font(.system(size: 17, weight: .semibold))
                            .foregroundStyle(Theme.Colors.textSecondary)
                            .frame(width: 44, height: 44).glassCircle()
                    }
                    .accessibilityLabel("Add photos")
                    .onChange(of: photoItems) { _, items in
                        guard !items.isEmpty else { return }
                        photoItems = []
                        Task { await attach(items) }
                    }
                    // Quote, list, numbered list, bold and the rest, as on the web.
                    Menu {
                        Button { draft = ChatFormat.toggleLine(draft, mark: "> ") } label: { Label("Quote", systemImage: "text.quote") }
                        Button { draft = ChatFormat.toggleLine(draft, mark: "- ") } label: { Label("Bulleted list", systemImage: "list.bullet") }
                        Button { draft = ChatFormat.toggleLine(draft, mark: "1. ") } label: { Label("Numbered list", systemImage: "list.number") }
                        Divider()
                        Button { draft = ChatFormat.wrapLast(draft, "*") } label: { Label("Bold", systemImage: "bold") }
                        Button { draft = ChatFormat.wrapLast(draft, "_") } label: { Label("Italic", systemImage: "italic") }
                        Button { draft = ChatFormat.wrapLast(draft, "~") } label: { Label("Strikethrough", systemImage: "strikethrough") }
                        Button { draft = ChatFormat.wrapLast(draft, "`") } label: { Label("Code", systemImage: "chevron.left.forwardslash.chevron.right") }
                    } label: {
                        Image(systemName: "textformat").font(.system(size: 16, weight: .semibold))
                            .foregroundStyle(Theme.Colors.textSecondary)
                            .frame(width: 44, height: 44).glassCircle()
                    }
                    .accessibilityLabel("Formatting")
                    TextField(placeholder, text: $draft, axis: .vertical)
                        .lineLimit(1...6)
                        .focused($focused)
                        .padding(.horizontal, 16).padding(.vertical, 11)
                        .glassPanel(cornerRadius: 22, interactive: true)
                        .accessibilityLabel(placeholder)
                    // Tap sends; hold for the rest — as a decision, or later.
                    Menu {
                        Button { Task { await submit(decide: true) } } label: { Label("Send as a decision", systemImage: "sparkles") }
                        Section("Schedule message") {
                            Button("In 30 minutes") { Task { await submit(at: .now.addingTimeInterval(1800)) } }
                            Button("In 1 hour") { Task { await submit(at: .now.addingTimeInterval(3600)) } }
                            Button("Tomorrow at 9:00") { Task { await submit(at: ChatTimes.tomorrow(at: 9)) } }
                            Button("Monday at 9:00") { Task { await submit(at: ChatTimes.nextMonday(at: 9)) } }
                            Button("Custom time…") { customTime = true }
                        }
                    } label: {
                        Image(systemName: editing == nil ? "arrow.up" : "checkmark")
                            .font(.system(size: 17, weight: .bold))
                            .foregroundStyle(canSend ? Color.white : Theme.Colors.textTertiary)
                            .frame(width: 44, height: 44)
                            .glassCircle(tint: canSend ? Theme.Colors.accent : nil)
                    } primaryAction: {
                        Task { await submit() }
                    }
                    .disabled(!canSend)
                    .accessibilityLabel(editing == nil ? Text("Send") : Text("Save"))
                    .accessibilityHint("Hold for more: send as a decision, or schedule.")
                }
            }
        }
    }

    private var canSend: Bool {
        uploading == 0 && (!draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || (!attached.isEmpty && editing == nil))
    }

    /// Picked photos: each made a JPEG (a HEIC would not show everywhere),
    /// uploaded, and held for the message you are about to send.
    private func attach(_ items: [PhotosPickerItem]) async {
        for (i, item) in items.enumerated() {
            uploading += 1
            defer { uploading -= 1 }
            guard let data = try? await item.loadTransferable(type: Data.self), let image = UIImage(data: data),
                  let jpeg = image.jpegData(compressionQuality: 0.85) else { continue }
            let w = Int(image.size.width * image.scale), h = Int(image.size.height * image.scale)
            let name = "photo-\(Int(Date().timeIntervalSince1970))-\(i + 1).jpg"
            if let file = await store.upload(view, data: jpeg, type: "image/jpeg", name: name, width: w, height: h) {
                attached.append(file)
            }
        }
    }

    @ViewBuilder
    private var slashSuggestions: some View {
        if draft.hasPrefix("/"), !draft.contains(" ") {
            let q = draft.dropFirst().lowercased()
            let all: [(String, LocalizedStringKey)] = [
                ("decide", "Send this as a decision for whoever should make it"),
                ("remember", "Add a rule to the playbook your AI follows"),
                ("routine", "Have your AI do something on a schedule"),
                ("schedule", "Send a message later: 30m, 1h, 2h, tomorrow, monday"),
            ]
            let hits = all.filter { $0.0.hasPrefix(q) }
            if !hits.isEmpty {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(hits.enumerated()), id: \.offset) { _, c in
                        Button { draft = "/\(c.0) " } label: {
                            HStack(alignment: .firstTextBaseline) {
                                Text(verbatim: "/\(c.0)").font(.subheadline.weight(.bold).monospaced())
                                Text(c.1).font(.caption).foregroundStyle(Theme.Colors.textSecondary)
                                Spacer()
                            }.padding(.horizontal, 14).padding(.vertical, 9).contentShape(Rectangle())
                        }.buttonStyle(.plain)
                    }
                }.glassPanel(cornerRadius: 18)
            }
        }
    }

    /// One line of "@": what it writes, what it shows, and how.
    private struct MentionOption: Identifiable {
        enum Kind { case special, ai, person, agent, group }
        let id: String
        let insert: String
        let label: String
        var detail: String? = nil
        var kind: Kind
        var emoji: String? = nil
        var avatarURL: String? = nil
        var online = false
        var outside = false
    }

    /// Who "@" offers here, as Slack orders them: @here, @channel and
    /// @agents first; then the people in this conversation, its agents, the
    /// groups, and the people outside it — each with a dot for whether they
    /// are at the app now.
    private func mentionOptions(query q: String) -> [MentionOption] {
        let online = Set(appState.onlineLogins.map { ChatHash.short($0) })
        let groupRefs = store.groups.first { $0.view == view }?.refs
        func inside(_ m: ChatMember) -> Bool {
            if m.mine { return true }
            if view.hasPrefix("dm:") { return view == "dm:\(m.ref)" }
            if let groupRefs { return groupRefs.contains(m.ref) }
            return true
        }
        let people = store.members.filter { !$0.mine }.map { m in
            MentionOption(id: m.ref, insert: m.handle ?? ChatMentionDirectory.runTogether(m.name), label: m.name, kind: .person,
                          avatarURL: m.avatarUrl, online: m.loginHash.map { online.contains($0) } ?? false, outside: !inside(m))
        }
        let agents = store.agentMentions(in: view)
        let here = people.filter { !$0.outside }
        var specials = [
            MentionOption(id: "__here", insert: "here", label: "@here", detail: String(localized: "Notifies the \(here.filter(\.online).count) people online here"), kind: .special),
            MentionOption(id: "__channel", insert: "channel", label: "@channel", detail: String(localized: "Notifies all \(here.count) people in this conversation"), kind: .special),
        ]
        // "@all" is "@channel" by another name: offered once it is being typed.
        if !q.isEmpty && "all".hasPrefix(q) {
            specials.append(MentionOption(id: "__all", insert: "all", label: "@all", detail: String(localized: "Notifies all \(here.count) people in this conversation"), kind: .special))
        }
        if !agents.isEmpty {
            specials.append(MentionOption(id: "__agents", insert: agents.map(\.handle).joined(separator: " @"), label: "@agents",
                                          detail: String(localized: "Calls all \(agents.count) agents in this conversation"), kind: .special))
        }
        let ai = [MentionOption(id: "__ai", insert: "AI", label: "AI", kind: .ai)]
        let agentOptions = agents.map { MentionOption(id: "agent:\($0.handle)", insert: $0.handle, label: $0.label, detail: "@\($0.handle)", kind: .agent, emoji: $0.emoji, avatarURL: $0.avatarUrl, online: true) }
        let groups = store.userGroups.map { MentionOption(id: "group:\($0.handle)", insert: $0.handle, label: $0.name, detail: "@\($0.handle)", kind: .group) }
        let ordered = specials + ai + here + agentOptions + groups + people.filter(\.outside)
        return ordered.filter { o in
            q.isEmpty || o.insert.lowercased().hasPrefix(q) || o.label.lowercased().hasPrefix(q) || o.label.lowercased().hasPrefix("@\(q)")
                || o.label.lowercased().split(separator: " ").contains { $0.hasPrefix(q) }
        }.prefix(8).map { $0 }
    }

    @ViewBuilder
    private var mentionSuggestions: some View {
        if let typing = Self.mentionQuery(in: draft) {
            let hits = mentionOptions(query: typing.query.lowercased())
            if !hits.isEmpty {
                VStack(spacing: 0) {
                    ForEach(hits) { o in
                        Button {
                            draft = typing.before + "@\(o.insert) "
                        } label: { mentionRow(o) }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.vertical, 4)
                .glassPanel(cornerRadius: 14)
                .padding(.horizontal, 12)
            }
        }
    }

    private func mentionRow(_ o: MentionOption) -> some View {
        HStack(spacing: 10) {
            if o.kind == .special {
                Text("@").font(.headline).foregroundStyle(Theme.Colors.textSecondary).frame(width: 26, height: 26)
            } else {
                ChatAvatar(name: o.label, isAI: o.kind == .ai, size: 26, agentEmoji: o.kind == .agent ? (o.emoji ?? "🤖") : nil, url: o.avatarURL)
                    .overlay(alignment: .bottomTrailing) {
                        if o.kind == .person || o.kind == .agent {
                            Circle().fill(o.online ? Color.green : Theme.Colors.textTertiary)
                                .frame(width: 9, height: 9)
                                .overlay(Circle().stroke(Theme.Colors.background, lineWidth: 2))
                                .offset(x: 2, y: 2)
                                .accessibilityLabel(o.online ? Text("Online") : Text("Offline"))
                        }
                    }
            }
            Text(o.label).font(.subheadline.weight(.semibold)).foregroundStyle(Theme.Colors.textPrimary).lineLimit(1)
            Spacer(minLength: 8)
            Group {
                if o.kind == .agent { Text("Agent") }
                else if o.outside { Text("Not in channel") }
                else if let d = o.detail { Text(d) }
            }
            .font(.caption).foregroundStyle(Theme.Colors.textTertiary).lineLimit(1)
        }
        .padding(.horizontal, 12).padding(.vertical, 7)
        .contentShape(Rectangle())
    }

    /// The @names in what is being written, each saying whether it reaches
    /// somebody: coloured when it does, grey when it names nobody. The one
    /// still being typed is left to the suggestions above.
    @ViewBuilder
    private var mentionCheck: some View {
        let tokens = ConversationView.mentionTokens(in: draft)
        if !tokens.isEmpty {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(Array(tokens.enumerated()), id: \.offset) { _, token in
                        if let kind = ChatMentionDirectory.shared.kind(of: token) {
                            Label(token, systemImage: "checkmark.circle.fill")
                                .font(.caption.weight(.semibold)).foregroundStyle(kind.color)
                                .padding(.horizontal, 8).padding(.vertical, 4)
                                .background(kind.color.opacity(0.14), in: Capsule())
                        } else {
                            Label(String(localized: "\(token) · nobody by that name"), systemImage: "questionmark.circle")
                                .font(.caption).foregroundStyle(Theme.Colors.textTertiary)
                                .padding(.horizontal, 8).padding(.vertical, 4)
                                .background(Theme.Colors.surfaceRaised, in: Capsule())
                        }
                    }
                }.padding(.horizontal, 4)
            }
            .accessibilityElement(children: .combine)
        }
    }

    /// The "@" being typed at the end of a draft — "@" or "＠", at the start,
    /// after a space or bracket, or right after Japanese ("確認@mi") — and
    /// the text before it. Nil when the draft does not end in one. The same
    /// rule as the Worker's: never after an ASCII letter, digit or URL
    /// character, so an address or a link offers no names.
    static func mentionQuery(in draft: String) -> (before: String, query: String)? {
        guard let at = draft.lastIndex(where: { $0 == "@" || $0 == "＠" }) else { return nil }
        let query = String(draft[draft.index(after: at)...])
        if query.count > 40 || query.contains(where: { $0.isWhitespace || "@＠,，。、!?！？:;)）」".contains($0) }) { return nil }
        if at > draft.startIndex {
            let prev = draft[draft.index(before: at)]
            let asciiPrintable = prev.unicodeScalars.count == 1 && (0x21...0x7E).contains(prev.unicodeScalars.first!.value)
            if asciiPrintable && !"([{\"'".contains(prev) { return nil }
        }
        return (String(draft[..<at]), query)
    }

    /// Finished @tokens in a draft: followed by a space or by more words.
    static func mentionTokens(in text: String) -> [String] {
        guard let regex = try? NSRegularExpression(pattern: #"(?:^|[\s(（「])([@＠][^\s@＠,，。、!?！？:;)）」]+)(?=[\s,，。、!?！？:;)）」]|$)"#) else { return [] }
        let ns = text as NSString
        var out: [String] = []
        for m in regex.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
            let r = m.range(at: 1)
            // The token at the very end is still being typed.
            if r.location + r.length == ns.length { continue }
            let token = ns.substring(with: r)
            if !out.contains(token) { out.append(token) }
        }
        return out
    }

    // MARK: Sending

    private func submit(decide: Bool = false, at: Date? = nil) async {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty || (!attached.isEmpty && editing == nil) else { return }
        if at != nil && !attached.isEmpty {
            notes.append(String(localized: "A scheduled message cannot carry files yet."))
            return
        }
        if let editing {
            await store.edit(editing, to: text)
            endEdit()
            return
        }
        // A command, not a message.
        if at == nil, text.hasPrefix("/") {
            let parts = text.dropFirst().split(separator: " ", maxSplits: 1).map(String.init)
            let name = parts.first?.lowercased() ?? ""
            let rest = parts.count > 1 ? parts[1].trimmingCharacters(in: .whitespaces) : ""
            if name == "decide" {
                guard !rest.isEmpty else { notes.append(String(localized: "Write what needs deciding after /decide.")); return }
                if await store.send(view, text: rest, decide: true) { clearSent(text) }
                return
            }
            if name == "schedule" {
                guard let parsed = ChatTimes.parseSchedule(rest) else {
                    notes.append(String(localized: "Try /schedule 30m …, /schedule 2h …, /schedule tomorrow … or /schedule monday …")); return
                }
                if await store.send(view, text: parsed.text, at: parsed.at) {
                    clearSent(text)
                    notes.append(String(localized: "Scheduled for \(parsed.at.formatted(date: .abbreviated, time: .shortened))."))
                }
                return
            }
            if let note = await store.command(view, name: name, rest: rest) { notes.append(note); clearSent(text) }
            return
        }
        let files = attached
        let clientId = unsent?.text == text ? unsent!.clientId : ChatService.newClientId()
        // Out of the box at once and into the conversation, faded until the
        // server has it (#212): one tap is one message (#205), and the next
        // can be written and sent while it goes.
        draft = ""
        attached = []
        let went = await store.send(view, text: text, decide: decide, replyTo: replyQuote, at: at, files: files, clientId: clientId)
        if went || store.isHeld(clientId) { replyingTo = nil }
        if went {
            unsent = nil
            if let at { notes.append(String(localized: "Scheduled for \(at.formatted(date: .abbreviated, time: .shortened)).")) }
        } else if store.isHeld(clientId) {
            // Not reached: it stays in the conversation, failed, with Try again.
            unsent = nil
        } else {
            // Did not go (or waits on a data rule): back as it was, unless
            // something new has been written meanwhile.
            unsent = (text, clientId)
            if draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { draft = text }
            if attached.isEmpty { attached = files }
        }
    }

    /// Sent: the box empties — unless more was written while it went, which
    /// stays, and stays kept.
    private func clearSent(_ text: String) {
        if draft.trimmingCharacters(in: .whitespacesAndNewlines) == text { draft = "" }
    }

    /// Answer this one: its quote over the box, and the box ready.
    private func startReply(_ m: ChatMessage) {
        if editing != nil { endEdit() }
        replyingTo = m
        focused = true
    }

    /// The quote the next message carries: of the message as it is now,
    /// so one edited or unsent meanwhile is quoted as it stands.
    private var replyQuote: ChatQuote? {
        guard let r = replyingTo else { return nil }
        return ChatQuote(of: list.first { $0.id == r.id } ?? r)
    }

    private func beginEdit(_ m: ChatMessage) {
        replyingTo = nil
        if editing == nil { keptDraft = draft }
        editing = m
        draft = m.body
        focused = true
    }

    private func endEdit() {
        editing = nil
        draft = keptDraft ?? store.draft(view)
        keptDraft = nil
    }

    private func open(card id: String) {
        if let card = appState.cardService.card(id: id) { openCard = card }
        else { notes.append(String(localized: "That decision is in your feed.")) }
    }

    // MARK: Toolbar and sheets

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        ToolbarItem(placement: .principal) {
            VStack(spacing: 1) {
                Text(title).font(.headline).lineLimit(1)
                if let m = conversation?.member {
                    if let away = ChatDates.parse(m.awayUntil) {
                        Text("Away until \(away.formatted(date: .abbreviated, time: .omitted))").font(.caption2).foregroundStyle(.orange)
                    } else if let s = m.status, (s.emoji ?? s.text) != nil {
                        Text(verbatim: "\(s.emoji ?? "") \(s.text ?? "")").font(.caption2).foregroundStyle(Theme.Colors.textSecondary).lineLimit(1)
                    }
                }
            }
            .onTapGesture { if let ref = conversation?.member?.ref { profileRef = ref } }
        }
        ToolbarItemGroup(placement: .topBarTrailing) {
            if !isAgentConversation {
                Button { jamOpen = true } label: { Image(systemName: "headphones") }
                    .accessibilityLabel("Jam")
                    .accessibilityHint("Start or join a call in this conversation.")
            }
            Button {
                Task {
                    let list = await store.pins(view)
                    // In the language you set, before the sheet opens.
                    await store.translate(view, list.filter { !$0.mine })
                    pins = list; showPins = true
                }
            } label: { Image(systemName: "pin") }
                .accessibilityLabel("Pinned messages")
            Menu {
                Button { canvasOpen = true } label: { Label("Canvas", systemImage: "doc.richtext") }
                if let c = conversation, c.kind == .channel || c.kind == .group {
                    Button { agentsOpen = true } label: { Label("Agents in this conversation", systemImage: "sparkles.rectangle.stack") }
                }
                if let c = conversation, c.kind == .channel {
                    Button { recordOpen = true } label: { Label("Record (Markdown)", systemImage: "doc.text.magnifyingglass") }
                }
                Button { Task { await store.toggleStar(view) } } label: {
                    Label(store.isStarred(view) ? LocalizedStringKey("Unstar") : LocalizedStringKey("Star"), systemImage: store.isStarred(view) ? "star.slash" : "star")
                }
                Menu {
                    ForEach(store.sidebar.sections) { s in
                        Button { Task { await store.move(view, to: s.id) } } label: {
                            if store.section(of: view)?.id == s.id { Label(s.name, systemImage: "checkmark") } else { Text(verbatim: s.name) }
                        }
                    }
                    if store.section(of: view) != nil {
                        Button("Back to where it was") { Task { await store.move(view, to: nil) } }
                    }
                    Button("New section…") { askingSectionName = true }
                } label: { Label("Move to a section", systemImage: "folder") }
                Picker("Notify me about", selection: Binding(get: { store.prefs[view] ?? "all" }, set: { v in Task { await store.setPref(view, level: v) } })) {
                    Text("Everything").tag("all")
                    Text("Mentions only").tag("mentions")
                    Text("Nothing (mute)").tag("mute")
                }
                if let c = conversation, c.kind == .channel {
                    Button {
                        Task {
                            let text = appState.readerLanguageCode == "ja" ? "毎日18時に #\(c.name) の会話と決定をまとめて" : "Every day at 18:00 summarise the conversation and decisions in #\(c.name)"
                            if let note = await store.command(view, name: "routine", rest: text) { notes.append(note) }
                        }
                    } label: { Label("Daily summary to me", systemImage: "text.badge.checkmark") }
                }
                if let ref = conversation?.member?.ref {
                    Button { profileRef = ref } label: { Label("Profile", systemImage: "person.crop.circle") }
                }
            } label: { Image(systemName: store.prefs[view] == "mute" ? "bell.slash" : "ellipsis.circle") }
                .accessibilityLabel("Conversation settings")
        }
    }

    private var pinsSheet: some View {
        NavigationStack {
            List {
                if pins.isEmpty {
                    Text("Nothing pinned yet. Long-press a message and pick Pin to channel.").foregroundStyle(Theme.Colors.textSecondary)
                }
                ForEach(pins) { m in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(m.isAI ? String(localized: "Your AI") : (m.mine ? String(localized: "You") : m.authorName ?? "")).font(.caption.weight(.semibold)).foregroundStyle(Theme.Colors.textSecondary)
                        Text(ChatTranslations.shared.shown(m).text).font(.subheadline).lineLimit(3)
                    }
                    .swipeActions { Button("Unpin") { Task { await store.togglePin(m); pins.removeAll { $0.id == m.id } } }.tint(.orange) }
                }
            }
            .navigationTitle("Pinned messages").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { showPins = false } } }
        }
        .presentationDetents([.medium, .large])
    }

    private var customTimeSheet: some View {
        NavigationStack {
            Form {
                DatePicker("Send at", selection: $customDate, in: Date().addingTimeInterval(120)..., displayedComponents: [.date, .hourAndMinute])
                    .datePickerStyle(.graphical)
            }
            .navigationTitle("Schedule message").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { customTime = false } }
                ToolbarItem(placement: .confirmationAction) { Button("Schedule") { customTime = false; Task { await submit(at: customDate) } } }
            }
        }
        .presentationDetents([.large])
    }
}

struct IdentifiedRef: Identifiable { let ref: String; var id: String { ref } }

/// The times people pick when they say "later".
enum ChatTimes {
    static func tomorrow(at hour: Int) -> Date {
        let cal = Calendar.current
        let tomorrow = cal.date(byAdding: .day, value: 1, to: .now) ?? .now
        return cal.date(bySettingHour: hour, minute: 0, second: 0, of: tomorrow) ?? tomorrow
    }
    static func nextMonday(at hour: Int) -> Date {
        let cal = Calendar.current
        var comps = DateComponents(); comps.weekday = 2; comps.hour = hour; comps.minute = 0
        return cal.nextDate(after: .now, matching: comps, matchingPolicy: .nextTime) ?? tomorrow(at: hour)
    }
    /// "/schedule 2h text", "/schedule tomorrow text", "/schedule monday text".
    static func parseSchedule(_ rest: String) -> (at: Date, text: String)? {
        let parts = rest.split(separator: " ", maxSplits: 1).map(String.init)
        guard parts.count == 2 else { return nil }
        let when = parts[0].lowercased(), text = parts[1].trimmingCharacters(in: .whitespaces)
        guard !text.isEmpty else { return nil }
        if when == "tomorrow" || when == "明日" { return (tomorrow(at: 9), text) }
        if when == "monday" || when == "月曜" { return (nextMonday(at: 9), text) }
        let digits = when.prefix { $0.isNumber }
        guard let n = Int(digits), n > 0 else { return nil }
        let unit = when.dropFirst(digits.count)
        if unit.hasPrefix("h") { return (.now.addingTimeInterval(Double(n) * 3600), text) }
        if unit.hasPrefix("m") { return (.now.addingTimeInterval(Double(n) * 60), text) }
        return nil
    }
}

/// What the workspace's data rules say about a message: a warning the person
/// may send through, or a block. Its own modifier, so the conversation's body
/// stays small enough to type-check.
private struct DataRuleAlerts: ViewModifier {
    @ObservedObject var store: ChatStore
    let onSent: () -> Void

    private var warning: Binding<Bool> {
        Binding(get: { store.dataWarning != nil }, set: { if !$0 { store.dataWarning = nil } })
    }
    private var blocked: Binding<Bool> {
        Binding(get: { store.dataBlocked != nil }, set: { if !$0 { store.dataBlocked = nil } })
    }
    private static func names(_ rules: [String]) -> String {
        rules.map { NSLocalizedString($0, comment: "") }.joined(separator: ", ")
    }

    func body(content: Content) -> some View {
        content
            .alert("Send this?", isPresented: warning, presenting: store.dataWarning) { (w: ChatStore.DataRuleWarning) in
                Button("Send anyway") { Task { if await store.sendAnyway(w) { onSent() } } }
                Button("Go back and edit", role: .cancel) { store.dataWarning = nil }
            } message: { (w: ChatStore.DataRuleWarning) in
                let what: String = Self.names(w.rules)
                Text("It looks like it contains \(what). Your workspace asks you to check before sending that here.")
            }
            .alert("Can't send this", isPresented: blocked) {
                Button("OK", role: .cancel) { store.dataBlocked = nil }
            } message: {
                Text(store.dataBlocked ?? "")
            }
    }
}

/// A conversation stays at its newest message while what is above it changes
/// size — a picture loading, a translation replacing the words — the way a
/// chat does. (iOS 18 and later; before that, the scroll after opening.)
private struct ChatStaysAtBottom: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 18.0, *) {
            content.defaultScrollAnchor(.bottom, for: .sizeChanges)
        } else {
            content
        }
    }
}
