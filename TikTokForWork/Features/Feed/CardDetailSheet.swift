import SwiftUI
import UIKit

struct CardDetailSheet: View {
    let card: DecisionCard
    /// Delete the card, when the person looking may. Nil hides the button.
    var onDelete: (() -> Void)? = nil
    @State private var confirmDelete = false
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var appState: AppState

    /// "Ask anything" about this card. The question typed, the one being
    /// answered, and what came back. It lives in the sheet, which scrolls,
    /// so the page under it stays one page.
    @State private var question = ""
    @State private var asked: String?
    @State private var answer: AskService.Answer?
    @State private var askError: String?
    @State private var busy = false

    /// The reply back to whoever asked, once the card is decided.
    @State private var draft: DraftService.Draft?
    @State private var draftError: String?
    @State private var drafting = false
    @State private var copied = false
    /// The box's text — the draft, read and changed — and where it went.
    @State private var replyText = ""
    @State private var sending = false
    @State private var sentVia: String?
    @State private var sendError: String?

    /// The thread: what people said under this card, the reactions, and
    /// the box for the next thing. "@Name" reaches that person.
    @State private var thread: ThreadService.Thread?
    @State private var threadError: String?
    @State private var comment = ""
    @State private var posting = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
                    if let reason = card.routingReason {
                        detailSection(title: "Why you") {
                            Text(reason)
                                .font(Theme.TypeScale.body)
                                .foregroundStyle(Theme.Colors.textPrimary)
                        }
                    }

                    detailSection(title: "Summary") {
                        Text(card.displaySummary)
                            .font(Theme.TypeScale.body)
                            .foregroundStyle(Theme.Colors.textSecondary)
                            .lineSpacing(4)
                    }

                    if card.dailyReport != nil, card.recipientUserID == appState.currentUser?.id {
                        detailSection(title: "Daily report") {
                            DailyReportEditor(card: card)
                        }
                    }

                    detailSection(title: "Thread") {
                        threadBlock
                    }

                    detailSection(title: "Ask your AI") {
                        askBlock
                    }

                    if card.decision != nil, isOnThisCard {
                        detailSection(title: "Reply to whoever asked") {
                            draftBlock
                        }
                    }

                    if !card.displayContext.isEmpty {
                        detailSection(title: "Context") {
                            ContextInsightView(context: card.displayContext)
                        }
                    }

                    if let source = card.sourceInstruction, source != card.summary {
                        detailSection(title: "Original message") {
                            Text(source)
                                .font(Theme.TypeScale.caption)
                                .foregroundStyle(Theme.Colors.textTertiary)
                                .lineSpacing(4)
                        }
                    }

                    if let note = card.revisionNote, !note.isEmpty {
                        detailSection(title: "Revision note") {
                            Text(note)
                                .font(Theme.TypeScale.caption)
                                .foregroundStyle(Theme.Colors.textSecondary)
                        }
                    }

                    if let labels = card.labels, !labels.isEmpty {
                        detailSection(title: "Labels") {
                            HStack {
                                ForEach(labels, id: \.self) { label in
                                    LabelChip(text: label)
                                }
                            }
                        }
                    }

                    detailSection(title: "Routing") {
                        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                            metaRow("From", card.senderName)
                            metaRow("Type", card.type.label)
                            metaRow("Priority", card.priority.rawValue.capitalized)
                            metaRow("Status", card.status.label)
                            metaRow("Created", DateFormatting.relative(card.createdAt))
                            if let route = card.agentRoute {
                                metaRow("Agent path", route)
                            }
                        }
                    }

                    if let issueURL = card.githubIssueURL, let url = URL(string: issueURL) {
                        detailSection(title: "GitHub") {
                            Link(destination: url) {
                                HStack(spacing: 6) {
                                    Text(issueLabel)
                                    Image(systemName: "arrow.up.right")
                                        .font(.system(size: 11))
                                }
                                .font(Theme.TypeScale.caption)
                                .foregroundStyle(Theme.Colors.accent)
                            }
                        }
                    }
                }
                .padding(Theme.Spacing.screen)
            }
            .background(Theme.Colors.background)
            .navigationTitle(card.displayTitle)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if onDelete != nil {
                    ToolbarItem(placement: .topBarLeading) {
                        Button(role: .destructive) { confirmDelete = true } label: { Image(systemName: "trash") }
                            .foregroundStyle(Theme.Colors.textSecondary)
                            .accessibilityLabel(Text("Delete card"))
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                        .foregroundStyle(Theme.Colors.textSecondary)
                }
            }
            .confirmationDialog("Delete this card?", isPresented: $confirmDelete, titleVisibility: .visible) {
                Button("Delete card", role: .destructive) { onDelete?(); dismiss() }
                Button("Cancel", role: .cancel) {}
            } message: { Text(card.displayTitle) }
        }
        .presentationBackground(Theme.Colors.surface)
        .presentationDragIndicator(.visible)
        .task { await loadThread() }
    }

    private var orgIdForThread: String { appState.currentUser?.teamID ?? SessionStore.orgId ?? "" }

    @ViewBuilder private var threadBlock: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            if let thread, !thread.reactions.isEmpty || !thread.available.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(thread.reactions) { r in
                            Button { react(r.emoji) } label: {
                                Text("\(r.emoji) \(r.count)")
                                    .font(Theme.TypeScale.caption)
                                    .padding(.horizontal, 9).padding(.vertical, 4)
                                    .background(r.mine ? Theme.Colors.interactive.opacity(0.15) : Theme.Colors.surfaceRaised)
                                    .clipShape(Capsule())
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel(Text("\(r.emoji) \(r.count)"))
                        }
                        Menu {
                            ForEach(thread.available, id: \.self) { emoji in
                                Button(emoji) { react(emoji) }
                            }
                        } label: {
                            Image(systemName: "face.smiling")
                                .font(.system(size: 14))
                                .foregroundStyle(Theme.Colors.textTertiary)
                                .padding(6)
                        }
                        .accessibilityLabel(Text("Add a reaction"))
                    }
                }
            }
            if let threadError {
                Text(threadError).font(Theme.TypeScale.caption).foregroundStyle(Theme.Colors.reject)
            } else if let thread {
                if thread.comments.isEmpty {
                    Text("Nobody has said anything yet.")
                        .font(Theme.TypeScale.caption)
                        .foregroundStyle(Theme.Colors.textTertiary)
                }
                ForEach(thread.comments) { c in
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(spacing: 6) {
                            Text(c.author == appState.currentUser?.id ? String(localized: "You") : c.displayAuthor)
                                .font(Theme.TypeScale.caption.weight(.semibold))
                                .foregroundStyle(Theme.Colors.textPrimary)
                            Text(String(c.createdAt.prefix(10)))
                                .font(Theme.TypeScale.caption)
                                .foregroundStyle(Theme.Colors.textTertiary)
                        }
                        Text(c.body)
                            .font(Theme.TypeScale.body)
                            .foregroundStyle(Theme.Colors.textPrimary)
                            .textSelection(.enabled)
                    }
                    .padding(.vertical, 4)
                }
            } else {
                ProgressView().controlSize(.small)
            }
            HStack(alignment: .bottom, spacing: 8) {
                TextField(String(localized: "Reply in thread — @ to name someone"), text: $comment, axis: .vertical)
                    .lineLimit(1...4)
                    .font(Theme.TypeScale.body)
                    .padding(8)
                    .background(Theme.Colors.surfaceRaised)
                    .clipShape(RoundedRectangle(cornerRadius: 10))
                    .disabled(posting)
                Button(posting ? String(localized: "Sending…") : String(localized: "Send")) { postComment() }
                    .font(Theme.TypeScale.caption.weight(.semibold))
                    .disabled(posting || comment.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
    }

    @MainActor private func loadThread() async {
        guard let base = appState.backendBaseURL, !orgIdForThread.isEmpty else { return }
        do {
            thread = try await ThreadService.load(cardId: card.id, orgId: orgIdForThread, backendBaseURL: base)
            threadError = nil
        } catch {
            threadError = error.localizedDescription
        }
    }

    private func postComment() {
        let text = comment.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !posting, !text.isEmpty, let base = appState.backendBaseURL, !orgIdForThread.isEmpty else { return }
        Haptics.light()
        posting = true
        Task { @MainActor in
            do {
                let posted = try await ThreadService.post(cardId: card.id, orgId: orgIdForThread, body: text, backendBaseURL: base)
                let current = thread ?? ThreadService.Thread(comments: [], reactions: [], available: [])
                thread = ThreadService.Thread(comments: current.comments + [posted], reactions: current.reactions, available: current.available)
                comment = ""
                threadError = nil
            } catch {
                threadError = error.localizedDescription
            }
            posting = false
        }
    }

    private func react(_ emoji: String) {
        guard let base = appState.backendBaseURL, !orgIdForThread.isEmpty else { return }
        Haptics.light()
        Task { @MainActor in
            do {
                let reactions = try await ThreadService.react(cardId: card.id, orgId: orgIdForThread, emoji: emoji, backendBaseURL: base)
                let current = thread ?? ThreadService.Thread(comments: [], reactions: [], available: [])
                thread = ThreadService.Thread(comments: current.comments, reactions: reactions, available: current.available)
            } catch {
                threadError = error.localizedDescription
            }
        }
    }

    private var issueLabel: String {
        if let number = card.githubIssueNumber {
            return "Issue #\(number)"
        }
        return "View on GitHub"
    }

    /// A question about this card, answered from the card and what the team
    /// decided before — the same route the web asks, so both give one answer.
    private var askBlock: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            HStack(spacing: Theme.Spacing.sm) {
                TextField(String(localized: "Ask anything…"), text: $question)
                    .font(Theme.TypeScale.body)
                    .submitLabel(.send)
                    .onSubmit(send)
                    .disabled(busy)
                    .accessibilityLabel(String(localized: "Ask your AI about this decision"))
                Button(action: send) {
                    Image(systemName: "arrow.up.circle.fill")
                        .font(.system(size: 22))
                        .foregroundStyle(canSend ? Theme.Colors.interactive : Theme.Colors.textTertiary)
                }
                .buttonStyle(.plain)
                .disabled(!canSend)
                .accessibilityLabel(String(localized: "Send"))
            }
            .padding(.horizontal, Theme.Spacing.md)
            .padding(.vertical, 10)
            .overlay {
                RoundedRectangle(cornerRadius: Theme.Radius.input)
                    .strokeBorder(Theme.Colors.border, lineWidth: 1)
            }

            if let asked {
                Text(asked)
                    .font(Theme.TypeScale.caption)
                    .foregroundStyle(Theme.Colors.textTertiary)
            }
            if busy {
                Text("Your AI is looking…")
                    .font(Theme.TypeScale.caption)
                    .foregroundStyle(Theme.Colors.textSecondary)
            }
            if let askError {
                Text(askError)
                    .font(Theme.TypeScale.caption)
                    .foregroundStyle(Theme.Colors.reject)
            }
            if let answer {
                Text(answer.answer)
                    .font(Theme.TypeScale.body)
                    .foregroundStyle(Theme.Colors.textPrimary)
                    .lineSpacing(4)
                    .textSelection(.enabled)
                if !answer.related.isEmpty {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Decided before")
                            .font(Theme.TypeScale.label)
                            .foregroundStyle(Theme.Colors.textTertiary)
                        ForEach(answer.related) { related in
                            HStack(alignment: .top, spacing: Theme.Spacing.sm) {
                                Text(related.when)
                                    .font(Theme.TypeScale.micro)
                                    .foregroundStyle(Theme.Colors.textTertiary)
                                    .frame(width: 72, alignment: .leading)
                                Text(related.title)
                                    .font(Theme.TypeScale.caption)
                                    .foregroundStyle(Theme.Colors.textSecondary)
                            }
                        }
                    }
                    .padding(.top, Theme.Spacing.xs)
                }
            }
        }
        .animation(.easeOut(duration: 0.15), value: busy)
    }

    /// Only the two people on the card can speak for it — the Worker
    /// refuses anyone else, so the button is not offered to them.
    private var isOnThisCard: Bool {
        guard let me = appState.currentUser?.id else { return false }
        return me == card.recipientUserID || me == card.senderUserID
    }

    /// A draft of the message telling the person who asked what was decided,
    /// in the language the request came in, signed by the decider. Shown to
    /// be read, changed and sent by the person; nothing is sent from here.
    private var draftBlock: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            if drafting {
                Text("Your AI is writing…")
                    .font(Theme.TypeScale.caption)
                    .foregroundStyle(Theme.Colors.textSecondary)
            } else if draft != nil {
                Text("A draft, in the language the request came in. Read it, change it, send it yourself.")
                    .font(Theme.TypeScale.micro)
                    .foregroundStyle(Theme.Colors.textTertiary)
                TextEditor(text: $replyText)
                    .font(Theme.TypeScale.body)
                    .foregroundStyle(Theme.Colors.textPrimary)
                    .scrollContentBackground(.hidden)
                    .frame(minHeight: 120)
                    .padding(Theme.Spacing.sm)
                    .background(Theme.Colors.surfaceRaised)
                    .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.image))
                    .disabled(sending || sentVia != nil)
                    .accessibilityLabel(String(localized: "The draft"))
                if let sentVia {
                    Text(String(localized: "Sent via \(sentVia)."))
                        .font(Theme.TypeScale.caption)
                        .foregroundStyle(Theme.Colors.textSecondary)
                } else {
                    HStack(spacing: Theme.Spacing.md) {
                        // Back the way it came, when it came from an app the
                        // Worker can reply through. The text is the box's.
                        if let app = card.sourceApp, DraftService.sendable.contains(app) {
                            Button(sending ? String(localized: "Sending…") : String(localized: "Send via \(app)"), action: sendReply)
                                .font(.system(size: 14, weight: .semibold))
                                // The page colour on the CTA fill: white on
                                // near-black by day, near-black on white by night.
                                .foregroundStyle(Theme.Colors.background)
                                .padding(.horizontal, 14)
                                .padding(.vertical, 8)
                                .background(Theme.Colors.ctaFill)
                                .clipShape(Capsule())
                                .disabled(sending || replyText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        }
                        Button(copied ? String(localized: "Copied") : String(localized: "Copy")) {
                            UIPasteboard.general.string = replyText
                            Haptics.light()
                            copied = true
                        }
                        .font(.system(size: 14, weight: .medium))
                        .foregroundStyle(copied ? Theme.Colors.textTertiary : Theme.Colors.interactive)
                    }
                    if let sendError {
                        Text(sendError)
                            .font(Theme.TypeScale.caption)
                            .foregroundStyle(Theme.Colors.reject)
                    }
                }
            } else {
                if let draftError {
                    Text(draftError)
                        .font(Theme.TypeScale.caption)
                        .foregroundStyle(Theme.Colors.reject)
                }
                // A refusal leaves the button in place: a second try is one tap.
                Button(String(localized: "Draft the reply"), action: requestDraft)
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(Theme.Colors.interactive)
            }
        }
        .animation(.easeOut(duration: 0.15), value: drafting)
    }

    private func requestDraft() {
        Haptics.light()
        draftError = nil
        copied = false
        let orgId = appState.currentUser?.teamID ?? SessionStore.orgId ?? ""
        guard let base = appState.backendBaseURL, !orgId.isEmpty else {
            draftError = DraftService.Failure.notSignedIn.errorDescription
            return
        }
        drafting = true
        let language = appState.readerLanguageCode
        Task { @MainActor in
            do {
                let made = try await DraftService.draft(
                    cardId: card.id, orgId: orgId, readerLanguage: language, backendBaseURL: base
                )
                draft = made
                replyText = made.draft
            } catch {
                draftError = error.localizedDescription
            }
            drafting = false
        }
    }

    private func sendReply() {
        let text = replyText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !sending, !text.isEmpty else { return }
        Haptics.light()
        sendError = nil
        let orgId = appState.currentUser?.teamID ?? SessionStore.orgId ?? ""
        guard let base = appState.backendBaseURL, !orgId.isEmpty else {
            sendError = DraftService.Failure.notSignedIn.errorDescription
            return
        }
        sending = true
        Task { @MainActor in
            do {
                let sent = try await DraftService.send(cardId: card.id, orgId: orgId, text: text, backendBaseURL: base)
                sentVia = sent.via ?? card.sourceApp ?? ""
                Haptics.success()
            } catch {
                sendError = error.localizedDescription
            }
            sending = false
        }
    }

    private var canSend: Bool {
        !busy && !question.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func send() {
        let text = question.trimmingCharacters(in: .whitespacesAndNewlines)
        guard canSend, !text.isEmpty else { return }
        Haptics.light()
        question = ""
        asked = text
        answer = nil
        askError = nil
        let orgId = appState.currentUser?.teamID ?? SessionStore.orgId ?? ""
        guard let base = appState.backendBaseURL, !orgId.isEmpty else {
            askError = AskService.Failure.notSignedIn.errorDescription
            return
        }
        busy = true
        let language = appState.readerLanguageCode
        Task { @MainActor in
            do {
                answer = try await AskService.ask(
                    cardId: card.id, orgId: orgId, question: text, readerLanguage: language, backendBaseURL: base
                )
            } catch {
                askError = error.localizedDescription
            }
            busy = false
        }
    }

    private func detailSection<Content: View>(title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            // The titles are in the catalog; a String is shown verbatim
            // unless it is read as a key.
            Text(LocalizedStringKey(title))
                .font(Theme.TypeScale.label)
                .foregroundStyle(Theme.Colors.textTertiary)
            content()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func metaRow(_ label: String, _ value: String) -> some View {
        HStack(alignment: .top, spacing: Theme.Spacing.md) {
            Text(label)
                .font(Theme.TypeScale.caption)
                .foregroundStyle(Theme.Colors.textTertiary)
                .frame(width: 72, alignment: .leading)
            Text(value)
                .font(Theme.TypeScale.caption)
                .foregroundStyle(Theme.Colors.textSecondary)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}
