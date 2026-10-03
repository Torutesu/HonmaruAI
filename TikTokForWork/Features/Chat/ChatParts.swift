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
    /// The agents by folded handle: who "@hayao" is.
    private(set) var agents: [String: ChatAgent] = [:]

    static func fold(_ s: String) -> String { s.precomposedStringWithCompatibilityMapping.lowercased() }
    /// A name with its spaces taken out (a full-width one too).
    static func runTogether(_ name: String) -> String { name.filter { !$0.isWhitespace } }

    func update(members: [ChatMember], groups: [ChatUserGroup], agents: [ChatAgent]) {
        var out: [String: ChatMentionKind] = ["ai": .ai]
        for m in members {
            // Its first word, and the whole of it run together: "@MikaSato",
            // "@佐藤健二" — how "@" writes a name with a space.
            let first = m.name.split(whereSeparator: \.isWhitespace).first.map(String.init)
            for n in [m.handle, m.name, first, Self.runTogether(m.name)].compactMap({ $0 }) where !n.isEmpty { out[Self.fold(n)] = .person }
        }
        for g in groups { out[Self.fold(g.handle)] = .group }
        for a in agents { out[Self.fold(a.handle)] = .agent }
        names = out
        self.agents = Dictionary(agents.map { (Self.fold($0.handle), $0) }, uniquingKeysWith: { first, _ in first })
    }

    /// What "@token" (or "＠token", or "@tokenに") names, or nil for nobody.
    func kind(of token: String) -> ChatMentionKind? {
        var raw = token
        if raw.hasPrefix("@") || raw.hasPrefix("＠") { raw.removeFirst() }
        let want = Self.fold(raw)
        if let k = names[want] { return k }
        if want.hasSuffix("に") || want.hasSuffix("へ") { return names[String(want.dropLast())] }
        if want == "ai" { return .ai }
        // "@channel", "@all", "@everyone", "@here" — and "@allの皆さん" —
        // call everyone, drawn like a group. "@alliance" does not.
        for word in ["channel", "all", "everyone", "here"] where want.hasPrefix(word) {
            let rest = want.dropFirst(word.count)
            if let next = rest.first, next.isASCII, next.isLetter || next.isNumber || "_.-".contains(next) { continue }
            return .group
        }
        return nil
    }

    var isLoaded: Bool { names.count > 1 }

    /// The first agent a text calls, "@hayao" or "@hayaoに" — an agent's
    /// work is the agent's, never a card for a person.
    func agentCalled(in text: String) -> ChatAgent? {
        guard let regex = try? NSRegularExpression(pattern: #"[@＠]([^\s@＠,，。、!?！？:;)）」]+)"#) else { return nil }
        let ns = text as NSString
        for m in regex.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
            let want = Self.fold(ns.substring(with: m.range(at: 1)))
            if let a = agents[want] { return a }
            // "@hayaoに頼む": the name, then a particle, then the rest.
            for (handle, a) in agents where want.hasPrefix(handle) {
                let next = want.dropFirst(handle.count).first
                if next == "に" || next == "へ" { return a }
            }
        }
        return nil
    }
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

/// Messages in another language, in the reader's: kept per message with the
/// words they were translated from (an edit asks again), and which ones the
/// reader turned back to the original.
final class ChatTranslations: ObservableObject {
    static let shared = ChatTranslations()
    @Published private(set) var texts: [String: (from: String, text: String)] = [:]
    @Published var originals: Set<String> = []
    var off = false
    private var asked: Set<String> = []

    func store(_ id: String, from: String, text: String) { texts[id] = (from, text) }
    func shown(_ m: ChatMessage) -> (text: String, translated: Bool) {
        if let t = texts[m.id], t.from == m.body, t.text.trimmingCharacters(in: .whitespacesAndNewlines) != m.body.trimmingCharacters(in: .whitespacesAndNewlines), !originals.contains(m.id) { return (t.text, true) }
        return (m.body, false)
    }
    func hasTranslation(_ m: ChatMessage) -> Bool {
        guard let t = texts[m.id], t.from == m.body else { return false }
        return t.text.trimmingCharacters(in: .whitespacesAndNewlines) != m.body.trimmingCharacters(in: .whitespacesAndNewlines)
    }
    func toggle(_ id: String) { if originals.contains(id) { originals.remove(id) } else { originals.insert(id) } }
    /// The ones still to ask for, marked as asked.
    func wanted(_ list: [ChatMessage], reader: String) -> [ChatMessage] {
        guard !off else { return [] }
        let out = list.filter { m in
            guard m.deleted != true, let lang = m.lang, lang != reader, texts[m.id]?.from != m.body else { return false }
            return !asked.contains("\(m.id):\(m.body)")
        }
        for m in out { asked.insert("\(m.id):\(m.body)") }
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
                } else if let number = ChatRichText.numbered(line) {
                    // "1. " — a numbered list keeps its numbers.
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text(verbatim: "\(number.n).").foregroundStyle(Theme.Colors.textSecondary).monospacedDigit()
                        Text(ChatText.attributed(number.rest))
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

    /// "12. words" → (12, "words"); nil for anything else.
    static func numbered(_ line: String) -> (n: Int, rest: String)? {
        guard let dot = line.firstIndex(of: "."), dot > line.startIndex,
              let n = Int(line[line.startIndex..<dot]), n < 1000 else { return nil }
        let after = line.index(after: dot)
        guard after < line.endIndex, line[after] == " " else { return nil }
        return (n, String(line[line.index(after: after)...]))
    }
}

/// A person as a chat client draws them: their photo when they have one,
/// otherwise their initial in a rounded square. An agent the team wrote is
/// its picture, when somebody gave it one, else its emoji on a tile.
struct ChatAvatar: View {
    let name: String
    var isAI = false
    var size: CGFloat = 36
    /// Set for one of the team's agents: the face it was given.
    var agentEmoji: String? = nil
    /// Their photo — or an agent's picture — when they have one.
    var url: String? = nil
    var body: some View {
        Group {
            if !isAI, let raw = url, !raw.isEmpty, let photo = URL(string: raw) {
                AsyncImage(url: photo) { phase in
                    if let image = phase.image {
                        image.resizable().scaledToFill()
                    } else if let agentEmoji {
                        emojiTile(agentEmoji)
                    } else {
                        initial
                    }
                }
                .frame(width: size, height: size)
                .clipShape(RoundedRectangle(cornerRadius: size * 0.28, style: .continuous))
            } else if let agentEmoji {
                emojiTile(agentEmoji)
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

    private func emojiTile(_ emoji: String) -> some View {
        Text(emoji).font(.system(size: size * 0.55))
            .frame(width: size, height: size)
            .background(Theme.Colors.accent.opacity(0.14), in: RoundedRectangle(cornerRadius: size * 0.28, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: size * 0.28, style: .continuous).stroke(Theme.Colors.accent.opacity(0.35), lineWidth: 1))
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

/// Files' addresses kept fresh: each file is kept by its id, and a minute
/// before its address runs out a new one is asked for (POST /media/urls),
/// with the others due about then.
@MainActor
final class ChatMediaURLs: ObservableObject {
    static let shared = ChatMediaURLs()
    @Published private(set) var fresh: [String: ChatService.FreshFile] = [:]
    private var asked: [String: Date] = [:]
    private var orgId: String?

    /// The best address known for a file.
    func address(_ f: ChatFile, base: URL) -> URL? {
        if let got = fresh[f.id], got.expiresAt > (f.expiresAt ?? 0) { return URL(string: got.url, relativeTo: base)?.absoluteURL }
        return f.address(base: base)
    }

    private func expiry(_ f: ChatFile) -> Double? {
        max(fresh[f.id]?.expiresAt ?? 0, f.expiresAt ?? 0).nonZero
    }

    /// Renews the ones due within a minute; returns how long until the next
    /// one is, in seconds.
    func renewDue(_ files: [ChatFile], base: URL) async -> TimeInterval? {
        let now = Date().timeIntervalSince1970 * 1000
        let org = SessionStore.orgId
        if org != orgId { fresh = [:]; orgId = org }
        let due = files.filter { f in
            guard let at = expiry(f) else { return false }
            return at - 60_000 <= now && Date().timeIntervalSince(asked[f.id] ?? .distantPast) > 10
        }
        if let org, !due.isEmpty {
            for f in due { asked[f.id] = Date() }
            if let got = try? await ChatService.freshFileURLs(orgId: org, ids: due.map(\.id), base: base) {
                for (id, f) in got { fresh[id] = f }
            }
        }
        let next = files.compactMap { expiry($0) }.map { ($0 - 60_000 - Date().timeIntervalSince1970 * 1000) / 1000 }.filter { $0 > 0 }.min()
        return next
    }
}

private extension Double {
    var nonZero: Double? { self > 0 ? self : nil }
}

/// The files on a message: pictures at their own shape, the rest as a row
/// with its name and size. Preview stays inside the app.
struct ChatAttachments: View {
    let files: [ChatFile]
    @State private var preview: ChatFile?
    @Environment(\.chatAssets) private var assets
    @ObservedObject private var media = ChatMediaURLs.shared
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(files) { f in
                if let url = assets.base.flatMap({ media.address(f, base: $0) }) {
                    Button { preview = f } label: {
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
                                Image(systemName: "eye").foregroundStyle(Theme.Colors.textSecondary)
                            }
                            .padding(10)
                            .frame(maxWidth: 280)
                            .background(Theme.Colors.surfaceRaised, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                        }
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(Text(verbatim: f.name))
                }
            }
        }
        // Renewed while it is on screen, a minute before each runs out.
        .task(id: files.map(\.id)) {
            guard let base = assets.base else { return }
            while !Task.isCancelled {
                guard let wait = await media.renewDue(files, base: base) else { return }
                try? await Task.sleep(for: .seconds(max(wait, 5)))
            }
        }
        .sheet(item: $preview) { file in
            if let url = assets.base.flatMap({ media.address(file, base: $0) }) {
                ChatFilePreview(file: file, url: url)
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
                        // Who reacted: a long press on the phone, the pointer on an iPad.
                        .contextMenu {
                            Text(verbatim: who(r))
                            Button { onToggle(r.emoji) } label: {
                                Label(r.mine ? "Remove reaction" : "Add reaction", systemImage: r.mine ? "minus.circle" : "plus.circle")
                            }
                        }
                        .help(Text(verbatim: who(r)))
                        .accessibilityLabel(Text(verbatim: "\(r.emoji) \(r.count)"))
                        .accessibilityHint(Text(verbatim: who(r)))
                    }
                    Button(action: onAdd) {
                        Image(systemName: "face.smiling").font(.system(size: 14)).padding(.horizontal, 9).padding(.vertical, 5)
                            .background(Theme.Colors.surfaceRaised, in: Capsule()).foregroundStyle(Theme.Colors.textSecondary)
                    }.buttonStyle(.plain).accessibilityLabel("Add reaction")
                }
            }
        }
    }

    /// "Aki, Ren and You reacted with 👍", the names in the reader's language.
    private func who(_ r: ChatReaction) -> String {
        let names = r.refs.map(nameOf)
        let shown = names.count > 12 ? Array(names.prefix(12)) + [String(localized: "\(names.count - 12) others")] : names
        let list = ListFormatter.localizedString(byJoining: shown)
        return String(localized: "\(list) reacted with \(r.emoji)")
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
            ChatAvatar(name: agent.name, size: 28, agentEmoji: agent.glyph, url: agent.avatarUrl)
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
    @ObservedObject private var translations = ChatTranslations.shared
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
                    ChatAvatar(name: message.mine ? assets.myName ?? author : author, isAI: message.isAI, agentEmoji: message.isAgent ? (message.agent?.glyph ?? "🤖") : nil, url: message.isAgent ? message.agent?.avatarUrl : assets.avatar(of: message))
                }.buttonStyle(.plain).disabled(message.authorRef == nil || message.mine)
            }
            VStack(alignment: .leading, spacing: 4) {
                if message.pinned == true {
                    Label("Pinned", systemImage: "pin.fill").font(.caption2.weight(.semibold)).foregroundStyle(.orange)
                }
                // A thread reply sent to the conversation too: which thread
                // it answers, and pressed, that thread.
                if !inThread, message.alsoChannel == true, let quote = message.threadParent, !message.isDeleted {
                    Button(action: onOpenThread) {
                        HStack(spacing: 4) {
                            Image(systemName: "bubble.left.and.bubble.right").font(.caption2)
                            if quote.deleted {
                                Text("Replied to a thread that was deleted").font(.caption.italic())
                            } else {
                                Text("Replied to a thread:").font(.caption.weight(.semibold))
                                Text(verbatim: quote.excerpt).font(.caption).lineLimit(1)
                            }
                        }
                        .foregroundStyle(Theme.Colors.textSecondary)
                    }
                    .buttonStyle(.plain).disabled(quote.deleted)
                    .accessibilityIdentifier("threadReplyLine")
                }
                if !joined {
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text(author).font(.subheadline.weight(.bold)).foregroundStyle(Theme.Colors.textPrimary)
                        if message.isAI {
                            Text("AI").font(.caption2.weight(.heavy)).padding(.horizontal, 5).padding(.vertical, 1)
                                .background(Theme.Colors.surfaceRaised, in: RoundedRectangle(cornerRadius: 4)).foregroundStyle(Theme.Colors.textSecondary)
                        }
                        if message.isAgent {
                            Text(message.onBehalfOf?.name.map { String(localized: "\($0)'s agent") } ?? String(localized: "Agent")).font(.caption2.weight(.heavy)).padding(.horizontal, 5).padding(.vertical, 1)
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
                        ChatRichText(text: translations.shown(message).text)
                        if translations.hasTranslation(message) {
                            Button { translations.toggle(message.id) } label: {
                                Text(translations.shown(message).translated ? LocalizedStringKey("Translated · Show original") : LocalizedStringKey("Show translation"))
                                    .font(.caption2).foregroundStyle(Theme.Colors.textTertiary)
                            }.buttonStyle(.plain)
                        }
                    }
                    if let files = message.files, !files.isEmpty { ChatAttachments(files: files) }
                    if message.kind == "message", message.previewsHidden != true, let link = ChatLinkMetadata.firstLink(in: message.body) { ChatLinkPreview(url: link) }
                    if message.editedAt != nil {
                        Text("(edited)").font(.caption2).foregroundStyle(Theme.Colors.textTertiary)
                    }
                    if inThread, message.alsoChannel == true {
                        Text("Also sent to the conversation").font(.caption2).foregroundStyle(Theme.Colors.textTertiary)
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
                                    // The AI and the team's agents answer in threads too.
                                    if ref == "ai" {
                                        ChatAvatar(name: String(localized: "Your AI"), isAI: true, size: 20)
                                    } else if ref.hasPrefix("agent:") {
                                        ChatAvatar(name: String(localized: "Agent"), size: 20, agentEmoji: "🤖")
                                    } else {
                                        ChatAvatar(name: nameOf(ref), size: 20, url: assets.avatars[ref])
                                    }
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

/// Somebody new came into the workspace: one quiet line, in your words.
struct ChatJoinedRow: View {
    let message: ChatMessage
    var body: some View {
        HStack(spacing: 10) {
            Text("👋").font(.body)
            Text(String(localized: "\(message.authorName ?? String(localized: "Someone")) joined the workspace. Say hello!"))
                .font(.subheadline).foregroundStyle(Theme.Colors.textPrimary)
            Text(message.date, style: .time).font(.caption).foregroundStyle(Theme.Colors.textTertiary)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 16).padding(.vertical, 6)
        .accessibilityElement(children: .combine)
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
