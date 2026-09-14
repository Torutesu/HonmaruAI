import Foundation

/// One card's history: every event about it, newest first, and the card
/// itself. History used to be a list of events — "Approved", "Created",
/// "Approved" — and a decision that had been asked about, drafted and
/// replied to was five rows nobody could open. It is one row per card now,
/// and the row opens the card.
struct HistoryThread: Identifiable, Equatable {
    /// The card's id.
    let id: String
    /// Newest first.
    let events: [CardEvent]
    /// The card as the feed has it now, or as the newest event recorded it.
    /// Nil only for a card no event remembered whole; that row cannot open.
    let card: DecisionCard?

    var latest: CardEvent { events[0] }

    var title: String { card?.title ?? latest.snapshot?.title ?? id }

    /// "pending", "approved", … — the live card's word, else the newest
    /// event's.
    var status: String? {
        if let card { return card.status.rawValue }
        return events.lazy.compactMap { $0.snapshot?.status }.first
    }

    var isDecided: Bool {
        if let card { return !card.isPending }
        return status.map { $0 != "pending" } ?? false
    }

    var isUndone: Bool { latest.type == "rolled_back" }

    var isWaiting: Bool { !isDecided && latest.type != "deleted" }

    /// Everyone who acted on it, in the order they last did.
    var actors: [String] {
        var seen: [String] = []
        for actor in events.compactMap(\.actorUserId) where !seen.contains(actor) {
            seen.append(actor)
        }
        return seen
    }

    /// The events, grouped by card and ordered newest first — the thread
    /// with the latest event on top. `live` looks a card up in the feed, so
    /// a card that changed since the last event shows its current state.
    static func threads(from events: [CardEvent], live: (String) -> DecisionCard? = { _ in nil }) -> [HistoryThread] {
        var order: [String] = []
        var byCard: [String: [CardEvent]] = [:]
        for event in events {
            if byCard[event.cardId] == nil { order.append(event.cardId) }
            byCard[event.cardId, default: []].append(event)
        }
        return order.map { cardId -> HistoryThread in
            // ISO 8601 strings sort as dates.
            let sorted = byCard[cardId, default: []].sorted { $0.createdAt > $1.createdAt }
            let card = live(cardId) ?? sorted.lazy.compactMap(\.card).first
            return HistoryThread(id: cardId, events: sorted, card: card)
        }
        .sorted { $0.latest.createdAt > $1.latest.createdAt }
    }

    /// Title, whoever acted, and any note they left — the three things
    /// someone actually remembers about a decision.
    func matches(_ query: String) -> Bool {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !trimmed.isEmpty else { return true }
        let haystack = [title, card?.summary] + events.flatMap { [$0.actorUserId, $0.note, $0.headline] }
        return haystack.compactMap { $0?.lowercased() }.contains { $0.contains(trimmed) }
    }
}

/// Kinds worth separating. `decided` is the one people actually come for, so
/// it is not buried under "everything".
enum HistoryFilter: String, CaseIterable, Identifiable {
    case all, decided, waiting, undone

    var id: String { rawValue }

    var label: String {
        switch self {
        case .all: String(localized: "All")
        case .decided: String(localized: "Decided")
        case .waiting: String(localized: "Waiting")
        case .undone: String(localized: "Undone")
        }
    }

    func matches(_ thread: HistoryThread) -> Bool {
        switch self {
        case .all: true
        case .decided: thread.isDecided
        case .waiting: thread.isWaiting
        case .undone: thread.isUndone
        }
    }
}
