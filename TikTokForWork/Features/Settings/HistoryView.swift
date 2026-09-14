import SwiftUI

/// Everything that has happened in this repo's feed, one row per card,
/// newest first. The backend gates it by membership, so a guest is told to
/// sign in rather than shown a failure.
///
/// History is not a feed to scroll — it is a place you go with a question:
/// "did that get approved?", "what did Bob decide last week?", "did I ever
/// answer Mika?". A row is a card: what happened to it last, how many times
/// it has been touched, and who touched it. It opens the card, where a
/// decided one can have its reply drafted, changed and sent.
struct HistoryView: View {
    @EnvironmentObject private var appState: AppState
    @State private var events: [CardEvent] = []
    @State private var message: String?
    @State private var isLoading = true
    @State private var query = ""
    @State private var filter: HistoryFilter = .all
    @State private var detailCard: DecisionCard?

    private var threads: [HistoryThread] {
        HistoryThread.threads(from: events) { appState.cardService.card(id: $0) }
    }

    private var visibleThreads: [HistoryThread] {
        threads.filter { filter.matches($0) && $0.matches(query) }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                if isLoading {
                    ProgressView().frame(maxWidth: .infinity).padding(.top, Theme.Spacing.xl)
                } else if let message {
                    Text(message)
                        .font(Theme.TypeScale.body)
                        .foregroundStyle(Theme.Colors.textSecondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.top, Theme.Spacing.xl)
                } else if events.isEmpty {
                    Text(String(localized: "Nothing has happened yet."))
                        .font(Theme.TypeScale.body)
                        .foregroundStyle(Theme.Colors.textSecondary)
                        .padding(.top, Theme.Spacing.xl)
                } else {
                    filterBar
                    if visibleThreads.isEmpty {
                        // Distinct from "nothing has happened": the difference
                        // between an empty log and a search that found nothing
                        // is the difference between the product and the query.
                        Text(String(localized: "Nothing matches that."))
                            .font(Theme.TypeScale.caption)
                            .foregroundStyle(Theme.Colors.textTertiary)
                            .frame(maxWidth: .infinity, alignment: .center)
                            .padding(.top, Theme.Spacing.xl)
                    } else {
                        ForEach(visibleThreads) { thread in
                            row(thread)
                        }
                    }
                }
            }
            .padding(Theme.Spacing.md)
        }
        .navigationTitle(Text("History"))
        .searchable(text: $query, prompt: Text("Search decisions"))
        .refreshable { await load() }
        .task { await load() }
        .sheet(item: $detailCard) { card in
            CardDetailSheet(card: card)
                .presentationDetents([.medium, .large])
        }
    }

    private var filterBar: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: Theme.Spacing.sm) {
                ForEach(HistoryFilter.allCases) { option in
                    Button {
                        filter = option
                    } label: {
                        Text(option.label)
                            .font(.system(size: 13, weight: .medium))
                            .foregroundStyle(filter == option ? .white : Theme.Colors.textSecondary)
                            .padding(.horizontal, Theme.Spacing.md)
                            .padding(.vertical, 7)
                            .background(filter == option ? Theme.Colors.interactive : Theme.Colors.surfaceRaised)
                            .clipShape(Capsule())
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(filter == option ? [.isSelected] : [])
                }
            }
            .padding(.bottom, Theme.Spacing.xs)
        }
    }

    /// One card. What happened to it last is the headline; the title under
    /// it; then how many times it has been touched, and by whom.
    private func row(_ thread: HistoryThread) -> some View {
        let latest = thread.latest
        return VStack(alignment: .leading, spacing: 3) {
            HStack {
                Text(latest.headline)
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(Theme.Colors.textPrimary)
                Spacer()
                Text(RelativeTime.since(latest.createdAt))
                    .font(Theme.TypeScale.micro)
                    .foregroundStyle(Theme.Colors.textTertiary)
            }
            Text(thread.title)
                .font(Theme.TypeScale.caption)
                .foregroundStyle(Theme.Colors.textSecondary)
                .lineLimit(2)
            if let note = latest.note, !note.isEmpty {
                Text(note)
                    .font(Theme.TypeScale.micro)
                    .foregroundStyle(Theme.Colors.textSecondary)
                    .lineLimit(2)
            }
            HStack(spacing: Theme.Spacing.sm) {
                if thread.events.count > 1 {
                    Text(String(localized: "\(thread.events.count) events"))
                        .font(Theme.TypeScale.micro)
                        .foregroundStyle(Theme.Colors.textTertiary)
                }
                if !thread.actors.isEmpty {
                    Text(thread.actors.map { DisplayName.of($0, in: appState.organization) }.joined(separator: " · "))
                        .font(Theme.TypeScale.micro)
                        .foregroundStyle(Theme.Colors.textTertiary)
                        .lineLimit(1)
                }
                Spacer()
                if thread.card != nil {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(Theme.Colors.textTertiary)
                }
            }
        }
        .padding(Theme.Spacing.md)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.Colors.background)
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.image))
        .overlay {
            RoundedRectangle(cornerRadius: Theme.Radius.image)
                .strokeBorder(Theme.Colors.border, lineWidth: 1)
        }
        .contentShape(Rectangle())
        .onTapGesture {
            // A row that has the card opens it; one that does not (an old
            // event that recorded less) is just a row.
            guard let card = thread.card else { return }
            detailCard = card
        }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(thread.card != nil ? .isButton : [])
        .accessibilityHint(thread.card != nil ? Text("Opens the card") : Text(""))
    }

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        guard let repository = appState.githubService.connection?.repository,
              let base = appState.backendBaseURL else {
            message = String(localized: "Sign in to see your team's history.")
            return
        }
        let parts = repository.split(separator: "/")
        guard parts.count == 2 else {
            message = String(localized: "Sign in to see your team's history.")
            return
        }
        do {
            events = try await HistoryService.fetch(
                owner: String(parts[0]), repo: String(parts[1]), backendBaseURL: base
            )
            message = nil
        } catch {
            message = error.localizedDescription
        }
    }
}

/// Coarse relative time — "3m", "2h", "5d". Precision beyond this is noise in an
/// activity list.
enum RelativeTime {
    static func since(_ iso: String) -> String {
        let date = ISO8601DateFormatter.relayFractional.date(from: iso) ?? ISO8601DateFormatter.relayStandard.date(from: iso)
        guard let date else { return "" }
        let seconds = Int(Date().timeIntervalSince(date))
        if seconds < 60 { return String(localized: "just now") }
        if seconds < 3600 { return "\(seconds / 60)m" }
        if seconds < 86_400 { return "\(seconds / 3600)h" }
        return "\(seconds / 86_400)d"
    }
}
