import SwiftUI

/// What an @name reaches: the AI, a person, a user group or an agent.
enum ChatMentionKind: Equatable { case ai, person, group, agent
    var color: Color {
        switch self {
        case .ai: Theme.Colors.accent
        case .person: Theme.Colors.interactive
        case .group: Color.teal
        case .agent: Color.purple
        }
    }
}

/// Every name an @ can reach in this workspace, kept current by the chat
/// store. Only a name here is drawn as a mention; an @word that names
/// nobody stays plain text, so a typo reads as one. Before the team has
/// loaded it knows nothing, and every @word is drawn as before.
final class ChatMentionDirectory {
    static let shared = ChatMentionDirectory()
    private(set) var names: [String: ChatMentionKind] = [:]

    static func fold(_ s: String) -> String { s.precomposedStringWithCompatibilityMapping.lowercased() }

    func update(members: [ChatMember], groups: [ChatUserGroup], agents: [ChatAgent]) {
        var out: [String: ChatMentionKind] = ["ai": .ai]
        for m in members {
            let first = m.name.split(separator: " ").first.map(String.init)
            for n in [m.handle, m.name, first].compactMap({ $0 }) where !n.isEmpty { out[Self.fold(n)] = .person }
        }
        for g in groups { out[Self.fold(g.handle)] = .group }
        for a in agents { out[Self.fold(a.handle)] = .agent }
        names = out
    }

    /// What "@token" (or "＠token", or "@tokenに") names, or nil for nobody.
    func kind(of token: String) -> ChatMentionKind? {
        var raw = token
        if raw.hasPrefix("@") || raw.hasPrefix("＠") { raw.removeFirst() }
        let want = Self.fold(raw)
        if let k = names[want] { return k }
        if want.hasSuffix("に") || want.hasSuffix("へ") { return names[String(want.dropLast())] }
        return want == "ai" ? .ai : nil
    }

    var isLoaded: Bool { names.count > 1 }
}

/// Slack's formatting, read back natively: *bold*, _italic_, ~strike~ and
/// `code` become Markdown for AttributedString; "> " quotes and "- " lists
/// stay as lines, drawn with a bar or a bullet.
enum ChatText {
    static func attributed(_ text: String) -> AttributedString {
        var md = text
        // Slack's single marks to Markdown's, without touching URLs or code.
        md = md.replacingOccurrences(of: #"(?<![\w*])\*([^*\n]+)\*(?![\w*])"#, with: "**$1**", options: .regularExpression)
        md = md.replacingOccurrences(of: #"(?<![\w_])_([^_\n]+)_(?![\w_])"#, with: "*$1*", options: .regularExpression)
        md = md.replacingOccurrences(of: #"(?<![\w~])~([^~\n]+)~(?![\w~])"#, with: "~~$1~~", options: .regularExpression)
        let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        var out = (try? AttributedString(markdown: md, options: options)) ?? AttributedString(text)
        // @names that reach somebody, each in its kind's colour; an @word
        // that names nobody is left as it was written.
        let plain = String(out.characters)
        let directory = ChatMentionDirectory.shared
        if let regex = try? NSRegularExpression(pattern: #"[@＠][^\s@＠,，。、!?！？:;]+"#) {
            for match in regex.matches(in: plain, range: NSRange(plain.startIndex..., in: plain)) {
                guard let r = Range<AttributedString.Index>(match.range, in: out) else { continue }
                let word = String(out[r].characters)
                let kind: ChatMentionKind?
                if directory.isLoaded { kind = directory.kind(of: word) }
                else { kind = word.lowercased().hasPrefix("@ai") || word.lowercased().hasPrefix("＠ai") ? .ai : .person }
                guard let kind else { continue }
                out[r].foregroundColor = kind.color
                out[r].font = .body.weight(.semibold)
            }
        }
        return out
    }
}

/// A message's words, with quotes and lists as blocks.
struct ChatRichText: View {
    let text: String
    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            ForEach(Array(text.components(separatedBy: "\n").enumerated()), id: \.offset) { _, line in
                if line.hasPrefix("> ") || line == ">" {
                    HStack(spacing: 8) {
                        RoundedRectangle(cornerRadius: 2).fill(Theme.Colors.border).frame(width: 3)
                        Text(ChatText.attributed(String(line.dropFirst(2)))).foregroundStyle(Theme.Colors.textSecondary)
                    }.fixedSize(horizontal: false, vertical: true)
                } else if line.hasPrefix("- ") || line.hasPrefix("• ") {
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text("•").foregroundStyle(Theme.Colors.textSecondary)
                        Text(ChatText.attributed(String(line.dropFirst(2))))
                    }
                } else {
                    Text(ChatText.attributed(line))
                }
            }
        }
        .font(.body)
        .foregroundStyle(Theme.Colors.textPrimary)
        .textSelection(.enabled)
    }
}

/// A person as a chat client draws them: their photo when they have one,
/// otherwise their initial in a rounded square. An agent the team wrote is
/// its emoji on a tile.
struct ChatAvatar: View {
    let name: String
    var isAI = false
    var size: CGFloat = 36
    /// Set for one of the team's agents: the face it was given.
    var agentEmoji: String? = nil
    /// Their photo, when they have one.
    var url: String? = nil
    var body: some View {
        Group {
            if agentEmoji == nil, !isAI, let raw = url, let photo = URL(string: raw) {
                AsyncImage(url: photo) { phase in
                    if let image = phase.image {
                        image.resizable().scaledToFill()
                    } else {
                        initial
                    }
                }
                .frame(width: size, height: size)
                .clipShape(RoundedRectangle(cornerRadius: size * 0.28, style: .continuous))
            } else if let agentEmoji {
                Text(agentEmoji).font(.system(size: size * 0.55))
                    .frame(width: size, height: size)
                    .background(Theme.Colors.accent.opacity(0.14), in: RoundedRectangle(cornerRadius: size * 0.28, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: size * 0.28, style: .continuous).stroke(Theme.Colors.accent.opacity(0.35), lineWidth: 1))
            } else if isAI {
                Image(systemName: "sparkles").font(.system(size: size * 0.42, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(width: size, height: size)
                    .background(LinearGradient(colors: [Color(hex: 0x7D5BE7), Color(hex: 0xFA24CE), Color(hex: 0x0091FF)], startPoint: .topLeading, endPoint: .bottomTrailing), in: RoundedRectangle(cornerRadius: size * 0.28, style: .continuous))
            } else {
                initial
            }
        }.accessibilityHidden(true)
    }

    private var initial: some View {
        Text(String(name.prefix(1)).uppercased()).font(.system(size: size * 0.42, weight: .bold))
            .foregroundStyle(Theme.Colors.textPrimary)
            .frame(width: size, height: size)
            .background(Theme.Colors.surfaceRaised, in: RoundedRectangle(cornerRadius: size * 0.28, style: .continuous))
    }
}

/// What a message needs from its workspace to be drawn: its own emoji, and
/// the API's address that a file's signed path hangs from.
struct ChatAssets {
    var emoji: [ChatEmoji] = []
    var base: URL?
    /// Each member's photo, by ref; and yours.
    var avatars: [String: String] = [:]
    var myAvatar: String?
    var myName: String?
    /// The photo to draw for a message's author.
    func avatar(of message: ChatMessage) -> String? {
        if let a = message.authorAvatar, !a.isEmpty { return a }
        if message.mine { return myAvatar }
        return message.authorRef.flatMap { avatars[$0] }
    }
    func emojiURL(_ text: String) -> URL? {
        guard text.hasPrefix(":"), text.hasSuffix(":"), text.count > 2 else { return nil }
        let name = String(text.dropFirst().dropLast())
        return emoji.first { $0.name == name }.flatMap { URL(string: $0.url) }
    }
}

private struct ChatAssetsKey: EnvironmentKey { static let defaultValue = ChatAssets() }
extension EnvironmentValues {
    var chatAssets: ChatAssets {
        get { self[ChatAssetsKey.self] }
        set { self[ChatAssetsKey.self] = newValue }
    }
}

/// An emoji as it is drawn: the character, or this workspace's picture for
/// a `:name:` it has.
struct ChatEmojiGlyph: View {
    let emoji: String
    var size: CGFloat = 16
    @Environment(\.chatAssets) private var assets
    var body: some View {
        if let url = assets.emojiURL(emoji) {
            AsyncImage(url: url) { image in image.resizable().scaledToFit() } placeholder: { Color.clear }
                .frame(width: size, height: size)
                .accessibilityLabel(Text(verbatim: emoji))
        } else {
            Text(emoji).font(.system(size: size - 1))
        }
    }
}

/// The files on a message: pictures at their own shape, the rest as a row
/// with its name and size. Either opens where the phone shows it.
struct ChatAttachments: View {
    let files: [ChatFile]
    @Environment(\.chatAssets) private var assets
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(files) { f in
                if let url = assets.base.flatMap({ f.address(base: $0) }) {
                    Link(destination: url) {
                        if f.isPicture {
                            AsyncImage(url: url) { image in
                                image.resizable().scaledToFit()
                            } placeholder: {
                                Rectangle().fill(Theme.Colors.surfaceRaised)
                                    .aspectRatio(CGFloat(f.width ?? 4) / CGFloat(max(f.height ?? 3, 1)), contentMode: .fit)
                            }
                            .frame(maxWidth: 260, maxHeight: 260, alignment: .leading)
                            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                            .accessibilityLabel(Text(verbatim: f.name))
                        } else {
                            HStack(spacing: 10) {
                                Image(systemName: "doc").font(.system(size: 18)).foregroundStyle(Theme.Colors.textSecondary)
                                VStack(alignment: .leading, spacing: 1) {
                                    Text(verbatim: f.name).font(.subheadline.weight(.semibold)).lineLimit(1).foregroundStyle(Theme.Colors.textPrimary)
                                    Text(ByteCountFormatter.string(fromByteCount: Int64(f.size), countStyle: .file)).font(.caption).foregroundStyle(Theme.Colors.textSecondary)
                                }
                                Spacer(minLength: 0)
                                Image(systemName: "arrow.down.circle").foregroundStyle(Theme.Colors.textSecondary)
                            }
                            .padding(10)
                            .frame(maxWidth: 280)
                            .background(Theme.Colors.surfaceRaised, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                        }
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }
}

/// The reactions under a message: each emoji and how many, yours outlined.
struct ChatReactionBar: View {
    let message: ChatMessage
    let nameOf: (String) -> String
    let onToggle: (String) -> Void
    let onAdd: () -> Void
    var body: some View {
        let list = message.reactions ?? []
        if !list.isEmpty {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(list, id: \.emoji) { r in
                        Button { onToggle(r.emoji) } label: {
                            HStack(spacing: 4) {
                                ChatEmojiGlyph(emoji: r.emoji, size: 16)
                                Text(verbatim: "\(r.count)").font(.caption.weight(.bold)).monospacedDigit()
                            }
                            .padding(.horizontal, 9).padding(.vertical, 4)
                            .background(r.mine ? Theme.Colors.interactive.opacity(0.14) : Theme.Colors.surfaceRaised, in: Capsule())
                            .overlay(Capsule().stroke(r.mine ? Theme.Colors.interactive : .clear, lineWidth: 1))
                            .foregroundStyle(r.mine ? Theme.Colors.interactive : Theme.Colors.textPrimary)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(Text(verbatim: "\(r.emoji) \(r.count)"))
                        .accessibilityHint(Text(r.refs.map(nameOf).joined(separator: ", ")))
                    }
                    Button(action: onAdd) {
                        Image(systemName: "face.smiling").font(.system(size: 14)).padding(.horizontal, 9).padding(.vertical, 5)
                            .background(Theme.Colors.surfaceRaised, in: Capsule()).foregroundStyle(Theme.Colors.textSecondary)
                    }.buttonStyle(.plain).accessibilityLabel("Add reaction")
                }
            }
        }
    }
}

/// The emoji a reply is made of, most-used first.
struct ChatEmojiPicker: View {
    let onPick: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.chatAssets) private var assets
    private let sets: [(LocalizedStringKey, [String])] = [
        ("Frequently used", ["👍", "✅", "👀", "🙌", "🎉", "🙏", "❤️", "😂", "🔥", "💯", "👏", "🚀"]),
        ("Work", ["📌", "📎", "📅", "⏰", "💡", "❓", "❗", "⚠️", "🛑", "✍️", "📈", "💰", "🧾", "📦", "🤝", "🗳️"]),
        ("Feelings", ["😀", "😊", "😅", "🤔", "😮", "😢", "😬", "🙃", "😎", "🥳", "😴", "🤯"]),
        ("Answers", ["⭕", "❌", "🆗", "🆖", "👌", "👎", "🤞", "💪", "☕", "🍣", "🍺", "🌱"]),
    ]
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    if !assets.emoji.isEmpty {
                        VStack(alignment: .leading, spacing: 8) {
                            Text("This workspace").font(.caption.weight(.semibold)).foregroundStyle(Theme.Colors.textSecondary)
                            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 4), count: 8), spacing: 4) {
                                ForEach(assets.emoji) { e in
                                    Button { onPick(":\(e.name):"); dismiss() } label: {
                                        AsyncImage(url: URL(string: e.url)) { image in image.resizable().scaledToFit() } placeholder: { Color.clear }
                                            .frame(width: 30, height: 30).frame(maxWidth: .infinity, minHeight: 44)
                                    }.buttonStyle(PressFeedbackStyle()).accessibilityLabel(Text(verbatim: ":\(e.name):"))
                                }
                            }
                        }
                    }
                    ForEach(Array(sets.enumerated()), id: \.offset) { _, set in
                        VStack(alignment: .leading, spacing: 8) {
                            Text(set.0).font(.caption.weight(.semibold)).foregroundStyle(Theme.Colors.textSecondary)
                            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 4), count: 8), spacing: 4) {
                                ForEach(set.1, id: \.self) { e in
                                    Button { onPick(e); dismiss() } label: {
                                        Text(e).font(.system(size: 28)).frame(maxWidth: .infinity, minHeight: 44)
                                    }.buttonStyle(PressFeedbackStyle()).accessibilityLabel(e)
                                }
                            }
                        }
                    }
                }.padding(20)
            }
            .navigationTitle("Add reaction").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
        }
        .presentationDetents([.medium, .large])
        .presentationBackground(.regularMaterial)
    }
}

/// What the AI is doing, step by step, where a person waits for it.
struct ChatAISteps: View {
    let step: String
    private let steps: [(String, LocalizedStringKey)] = [("reading", "Reading the conversation"), ("routing", "Deciding who decides"), ("writing", "Writing the card")]
    var body: some View {
        let at = max(0, steps.firstIndex { $0.0 == step } ?? 0)
        HStack(alignment: .top, spacing: 10) {
            ChatAvatar(name: "AI", isAI: true, size: 28)
            VStack(alignment: .leading, spacing: 4) {
                ForEach(Array(steps.enumerated()), id: \.offset) { i, s in
                    HStack(spacing: 6) {
                        if i < at { Image(systemName: "checkmark.circle.fill").foregroundStyle(Theme.Colors.approve) }
                        else if i == at { ProgressView().controlSize(.mini) }
                        else { Image(systemName: "circle").foregroundStyle(Theme.Colors.textTertiary) }
                        Text(s.1).font(.footnote.weight(i == at ? .semibold : .regular))
                            .foregroundStyle(i <= at ? Theme.Colors.textPrimary : Theme.Colors.textTertiary)
                    }
                }
            }
            Spacer(minLength: 0)
        }
        .padding(12)
        .glassPanel(cornerRadius: 16)
        .padding(.horizontal, 16)
        .accessibilityElement(children: .combine)
        .transition(.move(edge: .bottom).combined(with: .opacity))
    }
}

/// One of the team's agents writing its answer in a thread.
struct ChatAgentTypingRow: View {
    let agent: ChatAgentFace
    var body: some View {
        HStack(spacing: 10) {
            ChatAvatar(name: agent.name, size: 28, agentEmoji: agent.glyph)
            Text("\(agent.name) is writing…").font(.footnote.weight(.semibold)).foregroundStyle(Theme.Colors.textPrimary)
            ProgressView().controlSize(.mini)
            Spacer(minLength: 0)
        }
        .padding(12)
        .glassPanel(cornerRadius: 16)
        .padding(.horizontal, 16)
        .accessibilityElement(children: .combine)
        .transition(.move(edge: .bottom).combined(with: .opacity))
    }
}

/// One message: who, when, the words (or a tombstone), what is under them.
struct ChatMessageRow: View {
    let message: ChatMessage
    var joined = false
    var inThread = false
    var highlighted = false
    let nameOf: (String) -> String
    let onReact: (String) -> Void
    let onAddReaction: () -> Void
    let onOpenThread: () -> Void
    let onOpenCard: (String) -> Void
    let onProfile: (String) -> Void

    @Environment(\.chatAssets) private var assets
    /// A message that is nothing but this workspace's emoji: drawn large.
    private var onlyEmoji: [String]? {
        let parts = message.body.split(whereSeparator: \.isWhitespace).map(String.init)
        guard !parts.isEmpty, parts.count <= 6, parts.allSatisfy({ assets.emojiURL($0) != nil }) else { return nil }
        return parts
    }

    private var author: String {
        if message.isAI { return String(localized: "Your AI") }
        if message.isAgent { return message.agent?.name ?? message.authorName ?? String(localized: "Agent") }
        if message.mine { return String(localized: "You") }
        return message.authorName ?? String(localized: "a teammate")
    }

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            if joined {
                Color.clear.frame(width: 36, height: 1)
            } else {
                Button { if let ref = message.authorRef, !message.mine { onProfile(ref) } } label: {
                    ChatAvatar(name: message.mine ? assets.myName ?? author : author, isAI: message.isAI, agentEmoji: message.isAgent ? (message.agent?.glyph ?? "🤖") : nil, url: assets.avatar(of: message))
                }.buttonStyle(.plain).disabled(message.authorRef == nil || message.mine)
            }
            VStack(alignment: .leading, spacing: 4) {
                if message.pinned == true {
                    Label("Pinned", systemImage: "pin.fill").font(.caption2.weight(.semibold)).foregroundStyle(.orange)
                }
                if !joined {
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text(author).font(.subheadline.weight(.bold)).foregroundStyle(Theme.Colors.textPrimary)
                        if message.isAI {
                            Text("AI").font(.caption2.weight(.heavy)).padding(.horizontal, 5).padding(.vertical, 1)
                                .background(Theme.Colors.surfaceRaised, in: RoundedRectangle(cornerRadius: 4)).foregroundStyle(Theme.Colors.textSecondary)
                        }
                        if message.isAgent {
                            Text("Agent").font(.caption2.weight(.heavy)).padding(.horizontal, 5).padding(.vertical, 1)
                                .background(Theme.Colors.accent.opacity(0.14), in: RoundedRectangle(cornerRadius: 4)).foregroundStyle(Theme.Colors.accent)
                            if let handle = message.agent?.handle, !handle.isEmpty {
                                Text(verbatim: "@\(handle)").font(.caption).foregroundStyle(Theme.Colors.textTertiary).lineLimit(1)
                            }
                        }
                        Text(message.date, style: .time).font(.caption).foregroundStyle(Theme.Colors.textTertiary)
                    }
                }
                if message.isDeleted {
                    Text("This message was deleted.").font(.body.italic()).foregroundStyle(Theme.Colors.textTertiary)
                } else {
                    if let big = onlyEmoji {
                        HStack(spacing: 4) { ForEach(Array(big.enumerated()), id: \.offset) { _, e in ChatEmojiGlyph(emoji: e, size: 34) } }
                    } else if !message.body.isEmpty {
                        ChatRichText(text: message.body)
                    }
                    if let files = message.files, !files.isEmpty { ChatAttachments(files: files) }
                    if message.editedAt != nil {
                        Text("(edited)").font(.caption2).foregroundStyle(Theme.Colors.textTertiary)
                    }
                }
                if let card = message.cardId, !message.isDeleted {
                    Button { onOpenCard(card) } label: {
                        Label(message.isAI ? LocalizedStringKey("Open the decision") : LocalizedStringKey("→ Decision"), systemImage: "rectangle.stack")
                            .font(.footnote.weight(.semibold)).padding(.horizontal, 10).padding(.vertical, 6)
                            .glassCapsule(interactive: true)
                    }.buttonStyle(.plain)
                }
                ChatReactionBar(message: message, nameOf: nameOf, onToggle: onReact, onAdd: onAddReaction)
                if !inThread, let n = message.replyCount, n > 0 {
                    Button(action: onOpenThread) {
                        HStack(spacing: 6) {
                            HStack(spacing: -6) {
                                ForEach(Array((message.replyRefs ?? []).prefix(3)), id: \.self) { ref in
                                    ChatAvatar(name: nameOf(ref), size: 20, url: assets.avatars[ref])
                                }
                            }
                            Text(n == 1 ? String(localized: "1 reply") : String(localized: "\(n) replies"))
                                .font(.footnote.weight(.bold)).foregroundStyle(Theme.Colors.interactive)
                            if let last = ChatDates.parse(message.lastReplyAt) {
                                Text(last, style: .relative).font(.caption).foregroundStyle(Theme.Colors.textTertiary)
                            }
                            Image(systemName: "chevron.right").font(.caption2).foregroundStyle(Theme.Colors.textTertiary)
                        }
                    }.buttonStyle(.plain)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, joined ? 2 : 8)
        .background(highlighted ? Color.orange.opacity(0.18) : (message.pinned == true ? Color.orange.opacity(0.06) : .clear))
        .contentShape(Rectangle())
    }
}

/// A day, between messages.
struct ChatDayDivider: View {
    let date: Date
    var body: some View {
        HStack {
            VStack { Divider() }
            Text(date, format: .dateTime.weekday(.wide).month().day())
                .font(.caption.weight(.semibold)).foregroundStyle(Theme.Colors.textSecondary)
                .padding(.horizontal, 10).padding(.vertical, 4)
                .glassCapsule()
            VStack { Divider() }
        }.padding(.horizontal, 16).padding(.vertical, 6)
    }
}

/// Where you left off.
struct ChatNewLine: View {
    var body: some View {
        HStack(spacing: 8) {
            Rectangle().fill(Color.red).frame(height: 1)
            Text("New").font(.caption2.weight(.heavy)).foregroundStyle(.red)
        }.padding(.horizontal, 16).padding(.vertical, 4).accessibilityLabel("New messages")
    }
}
