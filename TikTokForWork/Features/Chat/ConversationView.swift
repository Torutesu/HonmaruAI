import PhotosUI
import SwiftUI
import UIKit

enum ChatRoute: Hashable {
    case conversation(view: String, jump: String?)
    case activity
    case later
    case threads
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
    @FocusState private var focused: Bool
    @State private var editing: ChatMessage?
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

    private var conversation: ChatConversation? { store.conversation(for: view) }
    private var title: String {
        guard let c = conversation else { return "" }
        if c.kind == .channel { return c.isPrivate ? "🔒 \(c.name)" : "#\(c.name)" }
        return c.name
    }
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
                    Color.clear.frame(height: 1).id("bottom")
                }
                .padding(.bottom, 8)
            }
            .scrollDismissesKeyboard(.interactively)
            .defaultScrollAnchor(.bottom)
            .onChange(of: list.count) { _, _ in if jump == nil { withAnimation { proxy.scrollTo("bottom", anchor: .bottom) } } }
            .onChange(of: store.thinking[view]) { _, _ in withAnimation { proxy.scrollTo("bottom", anchor: .bottom) } }
            .task(id: view) {
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
                }
            }
            .safeAreaInset(edge: .bottom, spacing: 0) { bottomBar }
            .safeAreaInset(edge: .top, spacing: 0) { ChatBookmarksStrip(view: view).environmentObject(appState) }
        }
        .background(Theme.Colors.background)
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { toolbar }
        .onChange(of: draft) { _, text in store.setDraft(view, text) }
        .sheet(item: $reactingTo) { m in ChatEmojiPicker { e in Task { await store.react(m, e) } } }
        .sheet(isPresented: $showThread) { ChatThreadSheet(store: store, onOpenCard: open(card:)) }
        .sheet(isPresented: $showPins) { pinsSheet }
        .sheet(item: Binding(get: { profileRef.map { IdentifiedRef(ref: $0) } }, set: { profileRef = $0?.ref })) { r in
            ChatProfileSheet(store: store, ref: r.ref)
        }
        .sheet(item: $openCard) { CardDetailSheet(card: $0).environmentObject(appState) }
        .sheet(isPresented: $customTime) { customTimeSheet }
        .sheet(item: $forwarding) { m in ChatForwardSheet(store: store, message: m) }
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
        .confirmationDialog("Delete this message? This cannot be undone.", isPresented: Binding(get: { confirmDelete != nil }, set: { if !$0 { confirmDelete = nil } }), titleVisibility: .visible) {
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
                    Text("Talk about \(c.name) here. Write @AI — or long-press a message and pick Make it a decision — and your AI turns it into a decision card, written from what was said.")
                        .font(.subheadline).foregroundStyle(Theme.Colors.textSecondary)
                } else {
                    ChatAvatar(name: c.name, size: 48)
                    Text(c.name).font(.title3.weight(.bold))
                    Text("Just the two of you. Write @AI and your AI makes what you said a decision for \(c.name).")
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
            let joined = previous.map { $0.authorRef == m.authorRef && $0.kind == m.kind && m.date.timeIntervalSince($0.date) < 300 && Calendar.current.isDate($0.date, inSameDayAs: m.date) && m.pinned != true } ?? false
            ChatMessageRow(
                message: m, joined: joined, highlighted: highlight == m.id,
                nameOf: store.nameOf(ref:),
                onReact: { e in Task { await store.react(m, e) } },
                onAddReaction: { reactingTo = m },
                onOpenThread: { Task { await store.openThread(m) }; showThread = true },
                onOpenCard: open(card:),
                onProfile: { profileRef = $0 }
            )
            .id(m.id)
            .overlay(alignment: .topTrailing) {
                if clip.contains(where: { $0.id == m.id }) {
                    Image(systemName: "paperclip.circle.fill").font(.title3).foregroundStyle(Theme.Colors.accent).padding(8)
                }
            }
            .contextMenu { if !m.isDeleted { menu(for: m) } }
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
        Button { Task { await store.openThread(m) }; showThread = true } label: { Label("Reply in thread", systemImage: "bubble.left.and.bubble.right") }
        if m.mine && m.kind == "message" {
            Button { editing = m; draft = m.body; focused = true } label: { Label("Edit message", systemImage: "pencil") }
        }
        Button { UIPasteboard.general.string = m.body } label: { Label("Copy text", systemImage: "doc.on.doc") }
        Button { forwarding = m } label: { Label("Forward", systemImage: "arrowshape.turn.up.right") }
        if !m.mine {
            Button { Task { await store.markUnread(m) } } label: { Label("Mark unread", systemImage: "envelope.badge") }
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
                    Button("Cancel") { self.editing = nil; draft = "" }.font(.caption)
                }.padding(.horizontal, 14)
            }
            slashSuggestions
            mentionSuggestions
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

    @ViewBuilder
    private var mentionSuggestions: some View {
        if let token = draft.split(separator: " ", omittingEmptySubsequences: false).last, token.hasPrefix("@"), token.count >= 1 {
            let q = token.dropFirst().lowercased()
            let people = [("AI", "AI")] + store.members.filter { !$0.mine }.map { ($0.handle ?? $0.name, $0.name) }
                + store.userGroups.map { ($0.handle, "@\($0.handle) · \($0.name)") }
            let hits = people.filter { q.isEmpty || $0.0.lowercased().hasPrefix(q) || $0.1.lowercased().hasPrefix(q) }.prefix(5)
            if !hits.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(Array(hits.enumerated()), id: \.offset) { _, p in
                            Button {
                                var parts = draft.split(separator: " ", omittingEmptySubsequences: false).map(String.init)
                                parts[parts.count - 1] = "@\(p.0.contains(" ") ? p.1.replacingOccurrences(of: " ", with: "") : p.0) "
                                draft = parts.joined(separator: " ")
                            } label: {
                                HStack(spacing: 6) {
                                    ChatAvatar(name: p.1, isAI: p.0 == "AI", size: 22)
                                    Text(p.1).font(.footnote.weight(.semibold))
                                }.padding(.horizontal, 10).padding(.vertical, 6).glassCapsule(interactive: true)
                            }.buttonStyle(.plain)
                        }
                    }
                }
            }
        }
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
            self.editing = nil; draft = ""
            return
        }
        // A command, not a message.
        if at == nil, text.hasPrefix("/") {
            let parts = text.dropFirst().split(separator: " ", maxSplits: 1).map(String.init)
            let name = parts.first?.lowercased() ?? ""
            let rest = parts.count > 1 ? parts[1].trimmingCharacters(in: .whitespaces) : ""
            if name == "decide" {
                guard !rest.isEmpty else { notes.append(String(localized: "Write what needs deciding after /decide.")); return }
                if await store.send(view, text: rest, decide: true) { draft = "" }
                return
            }
            if name == "schedule" {
                guard let parsed = ChatTimes.parseSchedule(rest) else {
                    notes.append(String(localized: "Try /schedule 30m …, /schedule 2h …, /schedule tomorrow … or /schedule monday …")); return
                }
                if await store.send(view, text: parsed.text, at: parsed.at) {
                    draft = ""
                    notes.append(String(localized: "Scheduled for \(parsed.at.formatted(date: .abbreviated, time: .shortened))."))
                }
                return
            }
            if let note = await store.command(view, name: name, rest: rest) { notes.append(note); draft = "" }
            return
        }
        if await store.send(view, text: text, decide: decide, at: at, files: attached) {
            draft = ""
            attached = []
            if let at { notes.append(String(localized: "Scheduled for \(at.formatted(date: .abbreviated, time: .shortened)).")) }
        }
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
            Button { jamOpen = true } label: { Image(systemName: "headphones") }
                .accessibilityLabel("Jam")
                .accessibilityHint("Start or join a call in this conversation.")
            Button { Task { pins = await store.pins(view); showPins = true } } label: { Image(systemName: "pin") }
                .accessibilityLabel("Pinned messages")
            Menu {
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
                        Text(m.body).font(.subheadline).lineLimit(3)
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
