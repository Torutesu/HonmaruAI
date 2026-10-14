import SwiftUI

/// One channel's record: its context — what it is for, where things stand,
/// how it got here, what was decided and why, what is open — written by the
/// AI from what was said, then its decisions. Copied as Markdown to paste
/// anywhere.
struct ChannelRecordSheet: View {
    let view: String
    let title: String
    @EnvironmentObject private var appState: AppState
    @Environment(\.dismiss) private var dismiss
    @State private var record: ChatService.ChannelRecord?
    @State private var loading = true
    @State private var problem: String?
    @State private var copied = false
    @State private var rewriting = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    Text("This channel’s story and decisions, written by the AI from what was said. Written again when something new is said.")
                        .font(.footnote).foregroundStyle(Theme.Colors.textSecondary)
                    if loading && record == nil {
                        HStack(spacing: 8) { ProgressView(); Text("Reading the channel and writing its context…").font(.footnote) }
                    }
                    if let problem { Text(problem).font(.footnote).foregroundStyle(.red) }
                    if let record {
                        contextView(record)
                        decisionsView(record)
                    }
                }
                .padding(20)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .navigationTitle(Text(verbatim: "#\(title)"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button { Task { await copy() } } label: {
                        Label(copied ? LocalizedStringKey("Copied") : LocalizedStringKey("Copy as Markdown"), systemImage: copied ? "checkmark" : "doc.on.doc")
                    }
                    .disabled(record == nil)
                }
                ToolbarItem(placement: .topBarTrailing) { CloseButton { dismiss() } }
            }
            .task { await load() }
        }
    }

    @ViewBuilder private func contextView(_ record: ChatService.ChannelRecord) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Context").font(.headline)
            if let text = record.context, !text.isEmpty {
                ForEach(Array(text.components(separatedBy: "\n").enumerated()), id: \.offset) { _, line in
                    markdownLine(line)
                }
                if let at = ChatDates.parse(record.contextAt) {
                    HStack(spacing: 6) {
                        Text("Written \(at.formatted(date: .abbreviated, time: .shortened))")
                        Button(rewriting ? LocalizedStringKey("Writing…") : LocalizedStringKey("Write again")) { Task { rewriting = true; await load(refresh: true); rewriting = false } }
                            .disabled(rewriting)
                    }
                    .font(.caption).foregroundStyle(Theme.Colors.textSecondary)
                }
            } else {
                Text(record.contextNote == "noModel" ? LocalizedStringKey("No AI model is set up, so the context is not written yet.")
                     : record.contextNote == "quota" ? LocalizedStringKey("Today’s AI answers are used up; the context is written tomorrow.")
                     : LocalizedStringKey("Nothing said here yet."))
                    .font(.footnote).foregroundStyle(Theme.Colors.textSecondary)
            }
        }
    }

    /// Headings, bullets and inline marks; the rest as it was written.
    @ViewBuilder private func markdownLine(_ raw: String) -> some View {
        let line = raw.trimmingCharacters(in: .whitespaces)
        if line.isEmpty {
            Color.clear.frame(height: 2)
        } else if line.hasPrefix("#") {
            Text(inline(line.drop(while: { $0 == "#" }).trimmingCharacters(in: .whitespaces))).font(.subheadline.weight(.bold)).padding(.top, 8)
        } else if line.hasPrefix("- ") || line.hasPrefix("* ") {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(verbatim: "•")
                Text(inline(String(line.dropFirst(2))))
            }
            .font(.subheadline)
            .padding(.leading, raw.hasPrefix("  ") ? 14 : 0)
        } else {
            Text(inline(line)).font(.subheadline)
        }
    }

    private func inline(_ s: String) -> AttributedString {
        (try? AttributedString(markdown: s, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(s)
    }

    @ViewBuilder private func decisionsView(_ record: ChatService.ChannelRecord) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Decisions").font(.headline)
            let section = record.section
            if (section?.open.isEmpty ?? true) && (section?.decided.isEmpty ?? true) {
                Text("Nothing decided yet.").font(.footnote).foregroundStyle(Theme.Colors.textSecondary)
            }
            ForEach(section?.open ?? []) { e in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Image(systemName: "square").font(.caption)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(verbatim: e.title).font(.subheadline)
                        if let r = e.recipient { Text("Waiting on \(r)").font(.caption).foregroundStyle(Theme.Colors.textSecondary) }
                    }
                }
            }
            ForEach(section?.decided ?? []) { e in
                VStack(alignment: .leading, spacing: 2) {
                    Text(verbatim: e.title).font(.subheadline)
                    Text(verbatim: [String(e.decidedAt?.prefix(10) ?? ""), e.actionLabel, e.actor].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "))
                        .font(.caption).foregroundStyle(Theme.Colors.accent)
                    if let n = e.note, !n.isEmpty { Text(verbatim: "“\(n)”").font(.caption).italic().foregroundStyle(Theme.Colors.textSecondary) }
                }
                .padding(.vertical, 4)
            }
        }
    }

    private func load(refresh: Bool = false) async {
        guard let orgId = appState.currentUser?.teamID, let base = appState.backendBaseURL else { return }
        loading = true
        defer { loading = false }
        do {
            record = try await ChatService.channelRecord(orgId: orgId, channel: view, locale: appState.readerLanguageCode, refresh: refresh, base: base)
            problem = nil
        } catch {
            problem = String(localized: "The details did not load. Try again.")
        }
    }

    private func copy() async {
        guard let orgId = appState.currentUser?.teamID, let base = appState.backendBaseURL else { return }
        if let md = try? await ChatService.channelRecordMarkdown(orgId: orgId, channel: view, locale: appState.readerLanguageCode, base: base) {
            UIPasteboard.general.string = md
            copied = true
            try? await Task.sleep(nanoseconds: 2_000_000_000)
            copied = false
        }
    }
}
