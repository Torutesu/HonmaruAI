import SwiftUI

/// A daily report's draft, on its card: read it, change any of it, and post
/// it to the channel under your name. Nothing reaches the channel until you
/// press Post — and nothing but Post takes the draft off the feed. What you
/// type is kept on this phone, so leaving the screen does not lose an edit.
struct DailyReportEditor: View {
    let card: DecisionCard
    @EnvironmentObject private var appState: AppState
    @State private var text = ""
    @State private var loaded = false
    @State private var posting = false
    @State private var error: String?
    /// The words as posted, once they are — for a sheet holding the card as
    /// it was when it opened.
    @State private var postedText: String?
    @FocusState private var focused: Bool
    /// Asking the AI to change it: what was asked, what it did.
    @State private var ask = ""
    @State private var refining = false
    @State private var talk: [(ask: String, note: String)] = []

    /// A channel message holds this many characters, counted as the Worker
    /// counts them.
    static let maxCharacters = 4000

    private var storeKey: String { "daily-draft:\(card.id)" }

    var body: some View {
        if let report = card.dailyReport {
            VStack(alignment: .leading, spacing: 12) {
                if let postedText {
                    posted(report, text: postedText)
                } else if report.status == "posted" {
                    posted(report, text: report.text)
                } else if report.status == "expired" {
                    Label(String(localized: "This draft was replaced by a newer one."), systemImage: "clock.arrow.circlepath")
                        .font(.subheadline.weight(.semibold)).foregroundStyle(Theme.Colors.textSecondary)
                    Text(report.text).font(.body).foregroundStyle(Theme.Colors.textSecondary).textSelection(.enabled)
                } else {
                    editor(report)
                }
            }
            .onAppear {
                guard !loaded else { return }
                text = UserDefaults.standard.string(forKey: storeKey) ?? report.text
                loaded = true
            }
        }
    }

    private func posted(_ report: DailyReportDraft, text: String) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Label(String(localized: "Posted to \(report.channelName)"), systemImage: "checkmark.circle.fill")
                .font(.subheadline.weight(.semibold)).foregroundStyle(Theme.Colors.approve)
            Text(text).font(.body).lineSpacing(4).foregroundStyle(Theme.Colors.textPrimary).textSelection(.enabled)
        }
    }

    @ViewBuilder
    private func editor(_ report: DailyReportDraft) -> some View {
        Text(String(localized: "Draft for \(report.channelName) — change anything, then post"))
            .font(.caption.weight(.semibold)).foregroundStyle(Theme.Colors.textSecondary)
        TextEditor(text: $text)
            .font(.body)
            .frame(minHeight: 300)
            .padding(8)
            .scrollContentBackground(.hidden)
            .background(Theme.Colors.surface, in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(focused ? Theme.Colors.textPrimary : Theme.Colors.border, lineWidth: 1))
            .focused($focused)
            .accessibilityLabel(String(localized: "Your daily report"))
            .onChange(of: text) { _, value in
                if value == report.text { UserDefaults.standard.removeObject(forKey: storeKey) }
                else { UserDefaults.standard.set(value, forKey: storeKey) }
            }
        HStack(spacing: 12) {
            Text(verbatim: "\(text.utf16.count) / \(Self.maxCharacters)")
                .font(.caption.monospacedDigit())
                .foregroundStyle(text.utf16.count > Self.maxCharacters ? Theme.Colors.reject : Theme.Colors.textTertiary)
            Spacer(minLength: 8)
            if text != report.text {
                Button(String(localized: "Back to your AI’s draft")) { text = report.text }
                    .font(.caption).disabled(posting)
            }
        }
        let unwritten = report.unwrittenLines(in: text)
        if unwritten > 0 {
            Text(String(localized: "\(unwritten) lines still ask for your own words."))
                .font(.caption).foregroundStyle(Theme.Colors.textSecondary)
        }
        // Ask the AI to change it, the way you would ask a colleague.
        VStack(alignment: .leading, spacing: 6) {
            ForEach(Array(talk.enumerated()), id: \.offset) { _, x in
                Text(verbatim: x.ask).font(.caption).padding(.horizontal, 10).padding(.vertical, 5)
                    .background(Theme.Colors.textPrimary, in: Capsule()).foregroundStyle(Theme.Colors.background)
                    .frame(maxWidth: .infinity, alignment: .trailing)
                Text(verbatim: x.note).font(.caption).foregroundStyle(Theme.Colors.textSecondary)
            }
            if talk.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach([String(localized: "Make it shorter"), String(localized: "More polite"), String(localized: "Tidy the bullets")], id: \.self) { s in
                            Button(s) { refine(s) }.font(.caption).buttonStyle(.bordered).disabled(refining)
                        }
                    }
                }
            }
            HStack(spacing: 8) {
                Image(systemName: "sparkles").foregroundStyle(Theme.Colors.textSecondary)
                TextField(String(localized: "Ask your AI to change it"), text: $ask)
                    .font(.subheadline).submitLabel(.send).onSubmit { refine(ask) }
                if refining { ProgressView().controlSize(.small) }
                else { Button(String(localized: "Ask")) { refine(ask) }.font(.subheadline.weight(.semibold)).disabled(ask.trimmingCharacters(in: .whitespaces).isEmpty) }
            }
            .padding(10)
            .background(Theme.Colors.surface, in: RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.Colors.border, lineWidth: 1))
        }
        if let error {
            Text(error).font(.caption).foregroundStyle(Theme.Colors.reject)
        }
        PrimaryButton(title: posting ? String(localized: "Posting…") : String(localized: "Post to \(report.channelName)"), enabled: canPost) {
            post()
        }
    }

    private func refine(_ request: String) {
        let said = request.trimmingCharacters(in: .whitespacesAndNewlines)
        let orgId = appState.currentUser?.teamID ?? SessionStore.orgId ?? ""
        guard !said.isEmpty, !refining, let base = appState.backendBaseURL, !orgId.isEmpty else { return }
        refining = true; error = nil; ask = ""
        Task { @MainActor in
            do {
                let out = try await DailyReportService.refine(cardId: card.id, orgId: orgId, text: text, ask: said, backendBaseURL: base)
                text = out.text
                UserDefaults.standard.removeObject(forKey: storeKey)
                talk.append((ask: said, note: out.note ?? String(localized: "Done.")))
                Haptics.light()
            } catch { self.error = error.localizedDescription }
            refining = false
        }
    }

    private var canPost: Bool {
        !posting && !refining && !appState.isGuest
            && !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && text.utf16.count <= Self.maxCharacters
    }

    private func post() {
        let body = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let orgId = appState.currentUser?.teamID ?? SessionStore.orgId ?? ""
        guard canPost, let base = appState.backendBaseURL, !orgId.isEmpty else { return }
        focused = false
        posting = true
        error = nil
        Task { @MainActor in
            do {
                let posted = try await DailyReportService.post(cardId: card.id, orgId: orgId, text: body, backendBaseURL: base)
                UserDefaults.standard.removeObject(forKey: storeKey)
                postedText = posted.dailyReport?.text ?? body
                appState.cardService.applyFromWorker(posted)
                Haptics.success()
            } catch {
                self.error = error.localizedDescription
            }
            posting = false
        }
    }
}
