import SwiftUI

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
        // @names, and @AI in the AI's colour.
        let plain = String(out.characters)
        if let regex = try? NSRegularExpression(pattern: #"[@＠][^\s@＠,，。、!?！？:;]+"#) {
            for match in regex.matches(in: plain, range: NSRange(plain.startIndex..., in: plain)) {
                guard let r = Range<AttributedString.Index>(match.range, in: out) else { continue }
                let word = String(out[r].characters).lowercased()
                let isAI = word.hasPrefix("@ai") || word.hasPrefix("＠ai")
                out[r].foregroundColor = isAI ? Theme.Colors.accent : Theme.Colors.interactive
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

/// Initials in a rounded square, as a chat client draws a person.
struct ChatAvatar: View {
    let name: String
    var isAI = false
    var size: CGFloat = 36
    var body: some View {
        Group {
            if isAI {
                Image(systemName: "sparkles").font(.system(size: size * 0.42, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(width: size, height: size)
                    .background(LinearGradient(colors: [Color(hex: 0x7D5BE7), Color(hex: 0xFA24CE), Color(hex: 0x0091FF)], startPoint: .topLeading, endPoint: .bottomTrailing), in: RoundedRectangle(cornerRadius: size * 0.28, style: .continuous))
            } else {
                Text(String(name.prefix(1)).uppercased()).font(.system(size: size * 0.42, weight: .bold))
                    .foregroundStyle(Theme.Colors.textPrimary)
                    .frame(width: size, height: size)
                    .background(Theme.Colors.surfaceRaised, in: RoundedRectangle(cornerRadius: size * 0.28, style: .continuous))
            }
        }.accessibilityHidden(true)
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
                                Text(r.emoji).font(.system(size: 15))
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

    private var author: String {
        if message.isAI { return String(localized: "Your AI") }
        if message.mine { return String(localized: "You") }
        return message.authorName ?? String(localized: "a teammate")
    }

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            if joined {
                Color.clear.frame(width: 36, height: 1)
            } else {
                Button { if let ref = message.authorRef, !message.mine { onProfile(ref) } } label: {
                    ChatAvatar(name: author, isAI: message.isAI)
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
                        Text(message.date, style: .time).font(.caption).foregroundStyle(Theme.Colors.textTertiary)
                    }
                }
                if message.isDeleted {
                    Text("This message was deleted.").font(.body.italic()).foregroundStyle(Theme.Colors.textTertiary)
                } else {
                    ChatRichText(text: message.body)
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
                                    ChatAvatar(name: nameOf(ref), size: 20)
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
