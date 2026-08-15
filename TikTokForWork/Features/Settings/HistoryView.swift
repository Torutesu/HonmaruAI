import SwiftUI

/// Everything that has happened in this repo's feed, newest first. The backend
/// gates it by membership, so a guest is told to sign in rather than shown a
/// failure.
///
/// History is not a feed to scroll — it is a place you go with a question:
/// "did that get approved?", "what did Bob decide last week?". A list you can
/// only page through answers neither, so it filters and searches.
struct HistoryView: View {
    @EnvironmentObject private var appState: AppState
    @State private var events: [CardEvent] = []
    @State private var message: String?
    @State private var isLoading = true
    @State private var query = ""
    @State private var filter: HistoryFilter = .all

    /// Kinds worth separating. `decided` is the one people actually come for, so
    /// it is not buried under "everything".
    enum HistoryFilter: String, CaseIterable, Identifiable {
        case all, decided, created, undone

        var id: String { rawValue }

        var label: String {
            switch self {
            case .all: String(localized: "All")
            case .decided: String(localized: "Decided")
            case .created: String(localized: "Created")
            case .undone: String(localized: "Undone")
            }
        }

        func matches(_ event: CardEvent) -> Bool {
            switch self {
            case .all: true
            case .decided: event.type == "decided"
            case .created: event.type == "created"
            case .undone: event.type == "rolled_back"
            }
        }
    }

    private var visibleEvents: [CardEvent] {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return events.filter { event in
            guard filter.matches(event) else { return false }
            guard !trimmed.isEmpty else { return true }
            // Title, whoever acted, and any note they left — the three things
            // someone actually remembers about a decision.
            return [event.snapshot?.title, event.actorUserId, event.note, event.headline]
                .compactMap { $0?.lowercased() }
                .contains { $0.contains(trimmed) }
        }
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
                    if visibleEvents.isEmpty {
                        // Distinct from "nothing has happened": the difference
                        // between an empty log and a search that found nothing
                        // is the difference between the product and the query.
                        Text(String(localized: "Nothing matches that."))
                            .font(Theme.TypeScale.caption)
                            .foregroundStyle(Theme.Colors.textTertiary)
                            .frame(maxWidth: .infinity, alignment: .center)
                            .padding(.top, Theme.Spacing.xl)
                    } else {
                        ForEach(visibleEvents) { event in
                            row(event)
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

    private func row(_ event: CardEvent) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack {
                Text(event.headline)
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(Theme.Colors.textPrimary)
                Spacer()
                Text(RelativeTime.since(event.createdAt))
                    .font(Theme.TypeScale.micro)
                    .foregroundStyle(Theme.Colors.textTertiary)
            }
            Text(event.snapshot?.title ?? event.cardId)
                .font(Theme.TypeScale.caption)
                .foregroundStyle(Theme.Colors.textSecondary)
                .lineLimit(2)
            if let note = event.note, !note.isEmpty {
                Text(note)
                    .font(Theme.TypeScale.micro)
                    .foregroundStyle(Theme.Colors.textSecondary)
                    .lineLimit(2)
            }
            if let actor = event.actorUserId {
                Text(actor)
                    .font(Theme.TypeScale.micro)
                    .foregroundStyle(Theme.Colors.textTertiary)
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
        .accessibilityElement(children: .combine)
    }

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        guard let repository = appState.githubService.connection?.repository,
              let base = appState.backendBaseURL else {
            message = String(localized: "Sign in with GitHub to see your team's history.")
            return
        }
        let parts = repository.split(separator: "/")
        guard parts.count == 2 else {
            message = String(localized: "Sign in with GitHub to see your team's history.")
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
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let date = formatter.date(from: iso) ?? ISO8601DateFormatter().date(from: iso)
        guard let date else { return "" }
        let seconds = Int(Date().timeIntervalSince(date))
        if seconds < 60 { return String(localized: "just now") }
        if seconds < 3600 { return "\(seconds / 60)m" }
        if seconds < 86_400 { return "\(seconds / 3600)h" }
        return "\(seconds / 86_400)d"
    }
}
