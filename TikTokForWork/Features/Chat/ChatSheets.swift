import SwiftUI

/// A thread, as a sheet over the conversation: the message, its replies,
/// and a composer that answers under it.
struct ChatThreadSheet: View {
    @ObservedObject var store: ChatStore
    let onOpenCard: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var draft = ""
    @State private var reactingTo: ChatMessage?
    @FocusState private var focused: Bool

    var body: some View {
        NavigationStack {
            ScrollView {
                if let t = store.thread {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        row(t.parent)
                        HStack(spacing: 8) {
                            Text(t.replies.count == 1 ? String(localized: "1 reply") : String(localized: "\(t.replies.count) replies"))
                                .font(.caption.weight(.semibold)).foregroundStyle(Theme.Colors.textSecondary)
                            VStack { Divider() }
                        }.padding(.horizontal, 16).padding(.vertical, 8)
                        ForEach(t.replies) { row($0) }
                        if let step = store.thinking[t.parent.channel] { ChatAISteps(step: step).padding(.vertical, 6) }
                    }
                } else {
                    ProgressView().padding(40)
                }
            }
            .defaultScrollAnchor(.bottom)
            .safeAreaInset(edge: .bottom) {
                HStack(alignment: .bottom, spacing: 8) {
                    TextField("Reply… — @AI makes it a decision", text: $draft, axis: .vertical)
                        .lineLimit(1...5).focused($focused)
                        .padding(.horizontal, 16).padding(.vertical, 11)
                        .glassPanel(cornerRadius: 22, interactive: true)
                    Button {
                        guard let t = store.thread else { return }
                        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
                        Task { if await store.send(t.parent.channel, text: text, parentId: t.parent.id) { draft = "" } }
                    } label: {
                        Image(systemName: "arrow.up").font(.system(size: 17, weight: .bold)).foregroundStyle(.white)
                            .frame(width: 44, height: 44).glassCircle(tint: Theme.Colors.accent)
                    }
                    .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .accessibilityLabel("Send")
                }.padding(.horizontal, 12).padding(.vertical, 8)
            }
            .navigationTitle("Thread").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
            .sheet(item: $reactingTo) { m in ChatEmojiPicker { e in Task { await store.react(m, e) } } }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }

    private func row(_ m: ChatMessage) -> some View {
        ChatMessageRow(message: m, inThread: true, nameOf: store.nameOf(ref:),
                       onReact: { e in Task { await store.react(m, e) } },
                       onAddReaction: { reactingTo = m },
                       onOpenThread: {}, onOpenCard: onOpenCard, onProfile: { _ in })
            .contextMenu {
                if !m.isDeleted {
                    Button { reactingTo = m } label: { Label("Add reaction", systemImage: "face.smiling") }
                    Button { UIPasteboard.general.string = m.body } label: { Label("Copy text", systemImage: "doc.on.doc") }
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

    var body: some View {
        NavigationStack {
            ScrollView {
                if let p = profile {
                    VStack(spacing: 14) {
                        ChatAvatar(name: p.name, size: 96).padding(.top, 20)
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
                } else {
                    ProgressView().padding(60)
                }
            }
            .navigationTitle("Profile").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
            .task { profile = await store.profile(ref) }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
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
    var body: some View {
        List {
            if store.inbox.isEmpty {
                ContentUnavailableView("Nothing for you yet", systemImage: "bell",
                                       description: Text("When somebody writes @ your name, or replies in a thread you are part of, it shows up here."))
            }
            ForEach(store.inbox) { item in
                NavigationLink(value: ChatRoute.conversation(view: item.message.channel, jump: item.message.parentId ?? item.message.id)) {
                    VStack(alignment: .leading, spacing: 4) {
                        HStack {
                            if item.unread { Circle().fill(Theme.Colors.interactive).frame(width: 8, height: 8) }
                            Text(label(item))
                                .font(.caption).foregroundStyle(Theme.Colors.textSecondary)
                            Spacer()
                            Text(item.message.date, style: .relative).font(.caption2).foregroundStyle(Theme.Colors.textTertiary)
                        }
                        Text(item.message.isAI ? String(localized: "Your AI") : (item.message.authorName ?? "")).font(.subheadline.weight(.semibold))
                        Text(item.message.body).font(.subheadline).lineLimit(3).foregroundStyle(Theme.Colors.textPrimary)
                    }.padding(.vertical, 4)
                }
            }
        }
        .listStyle(.plain)
        .navigationTitle("Activity")
        .refreshable { await store.loadInbox() }
        .task { await store.loadInbox(); await store.markInboxRead() }
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
    var body: some View {
        List {
            if store.saved.isEmpty {
                ContentUnavailableView("Nothing saved", systemImage: "bookmark",
                                       description: Text("Long-press any message and pick Save for later."))
            }
            ForEach(store.saved) { item in
                NavigationLink(value: ChatRoute.conversation(view: item.message.channel, jump: item.message.id)) {
                    VStack(alignment: .leading, spacing: 4) {
                        if let at = ChatDates.parse(item.remindAt) {
                            Label(item.remindedAt == nil ? String(localized: "Reminder \(at.formatted(date: .abbreviated, time: .shortened))") : String(localized: "Reminded"), systemImage: "alarm")
                                .font(.caption).foregroundStyle(.orange)
                        }
                        Text(item.message.isAI ? String(localized: "Your AI") : (item.message.mine ? String(localized: "You") : item.message.authorName ?? "")).font(.subheadline.weight(.semibold))
                        Text(item.message.body).font(.subheadline).lineLimit(3)
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
        .task { await store.loadLater() }
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
                                ChatAvatar(name: m.name, size: 32)
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
