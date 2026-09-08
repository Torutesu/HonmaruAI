import SwiftUI

enum RequestQueue: String, CaseIterable {
    case inbox, sent, completed
    var title: String {
        switch self {
        case .inbox: String(localized: "Inbox")
        case .sent: String(localized: "Sent")
        case .completed: String(localized: "Completed")
        }
    }
}

struct FeedView: View {
    var queue: RequestQueue = .inbox
    var onCompose: () -> Void = {}
    @EnvironmentObject private var appState: AppState
    var body: some View {
        RequestQueueView(queue: queue, service: appState.cardService, onCompose: onCompose)
    }
}

private struct RequestQueueView: View {
    let queue: RequestQueue
    @ObservedObject var service: DecisionCardService
    let onCompose: () -> Void
    @EnvironmentObject private var appState: AppState
    @State private var search = ""
    @State private var priorityOnly = false
    @State private var oldestFirst = false
    @State private var selectedType: CardType?
    @State private var path: [String] = []
    @EnvironmentObject private var push: PushService

    private var cards: [DecisionCard] {
        guard let userID = appState.currentUser?.id else { return [] }
        return service.allCards(for: userID).filter { card in
            let inQueue = switch queue {
            case .inbox: card.recipientUserID == userID && card.isPending
            case .sent: card.senderUserID == userID && card.sourceDetail != "decision-result"
            case .completed: card.recipientUserID == userID && !card.isPending
            }
            let matchesSearch = search.isEmpty || [card.title, card.summary, memberName(card.senderUserID), memberName(card.recipientUserID)]
                .joined(separator: " ").localizedCaseInsensitiveContains(search)
            return inQueue && matchesSearch && (!priorityOnly || card.priority == .high || card.priority == .urgent)
                && (selectedType == nil || selectedType == card.type)
        }.sorted { oldestFirst ? $0.createdAt < $1.createdAt : $0.createdAt > $1.createdAt }
    }

    var body: some View {
        NavigationStack(path: $path) {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    workspaceStrip
                    searchField
                    filters
                    HStack {
                        Text(queue == .inbox ? String(localized: "Waiting for you") : queue == .sent ? String(localized: "Requests you created") : String(localized: "Your decisions and replies"))
                            .font(.subheadline.weight(.semibold))
                        Spacer()
                        Text("\(cards.count)").font(.subheadline.monospacedDigit()).foregroundStyle(Theme.Colors.textSecondary)
                    }
                    if cards.isEmpty { emptyState }
                    else {
                        LazyVStack(spacing: 0) {
                            ForEach(cards) { card in
                                NavigationLink(value: card.id) {
                                    RequestListRow(card: card, person: memberName(queue == .sent ? card.recipientUserID : card.senderUserID), isSent: queue == .sent, awaitingDelivery: service.awaitingDeliveryIDs.contains(card.id))
                                }
                                .buttonStyle(.plain)
                                if card.id != cards.last?.id { Divider().padding(.vertical, 16) }
                            }
                        }
                        .padding(18)
                        .background(Theme.Colors.background, in: RoundedRectangle(cornerRadius: 16))
                        .overlay(RoundedRectangle(cornerRadius: 16).stroke(Theme.Colors.border, lineWidth: 1))
                    }
                }
                .padding(.horizontal, 20)
                .padding(.top, 10)
                .padding(.bottom, 24)
            }
            .background(Theme.Colors.surface)
            .navigationTitle(queue.title)
            .navigationDestination(for: String.self) { RequestDetailView(cardID: $0, service: service) }
            .onChange(of: push.pendingCardID) { _, id in
                guard queue == .inbox, let id, service.card(id: id) != nil else { return }
                path = [id]
                push.pendingCardID = nil
            }
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button(action: onCompose) {
                        Label("New request", systemImage: "plus")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(Theme.Colors.ctaText)
                            .padding(.horizontal, 13).padding(.vertical, 10)
                            .background(Theme.Colors.ctaFill, in: Capsule())
                    }.buttonStyle(.plain)
                }
            }
            .refreshable {
                guard !appState.isGuest else { return }
                await appState.refreshWorkspaceMembers()
                await service.syncGitHubStatus(githubService: appState.githubService)
                appState.webSocketService.reconnectIfNeeded()
            }
        }
        .tint(Theme.Colors.accent)
    }

    private var workspaceStrip: some View {
        HStack(spacing: 8) {
            Image(systemName: appState.isGuest ? "square.stack.3d.up" : "building.2")
            Text(appState.workspaceDisplayName).lineLimit(1)
            Spacer(minLength: 4)
            if appState.isGuest { Text("Sample data").font(.caption.weight(.medium)) }
            else if appState.connectionState != .connected { Text("Offline").font(.caption.weight(.medium)) }
        }
        .font(.footnote).foregroundStyle(appState.isGuest ? Theme.Colors.accent : Theme.Colors.textSecondary)
    }

    private var searchField: some View {
        HStack(spacing: 10) {
            Image(systemName: "magnifyingglass").foregroundStyle(Theme.Colors.textTertiary)
            TextField("Search requests or people", text: $search).font(.body)
            if !search.isEmpty {
                Button { search = "" } label: { Image(systemName: "xmark.circle.fill") }
                    .accessibilityLabel("Clear search").foregroundStyle(Theme.Colors.textSecondary)
            }
        }
        .padding(13).background(Theme.Colors.background, in: RoundedRectangle(cornerRadius: 11))
        .overlay(RoundedRectangle(cornerRadius: 11).stroke(Theme.Colors.border, lineWidth: 1))
    }

    private var filters: some View {
        HStack(spacing: 8) {
            Menu {
                Button("All types") { selectedType = nil }
                ForEach(CardType.allCases, id: \.self) { type in Button(type.label) { selectedType = type } }
            } label: { Label(selectedType?.label ?? String(localized: "All types"), systemImage: "line.3.horizontal.decrease") }
            Toggle(isOn: $priorityOnly) { Text("High priority") }.toggleStyle(.button)
            Spacer(minLength: 0)
            Menu {
                Button("Newest first", systemImage: oldestFirst ? "circle" : "checkmark") { oldestFirst = false }
                Button("Oldest first", systemImage: oldestFirst ? "checkmark" : "circle") { oldestFirst = true }
            } label: { Image(systemName: "arrow.up.arrow.down").frame(width: 36, height: 34) }
                .accessibilityLabel("Sort requests")
        }
        .font(.caption.weight(.medium)).tint(Theme.Colors.accent)
        .buttonStyle(.bordered)
    }

    private var emptyState: some View {
        VStack(spacing: 12) {
            Image(systemName: queue == .inbox ? "tray" : queue == .sent ? "paperplane" : "checkmark.circle")
                .font(.system(size: 32)).foregroundStyle(Theme.Colors.accent)
            Text(search.isEmpty && !priorityOnly && selectedType == nil ? (queue == .inbox ? String(localized: "You're all caught up") : queue == .sent ? String(localized: "Send your first request") : String(localized: "Decisions will appear here")) : String(localized: "No matching requests"))
                .font(.headline)
            Text(queue == .inbox ? String(localized: "New requests from your teammates will appear here.") : queue == .sent ? String(localized: "Create a request and follow its outcome here.") : String(localized: "Approve, reply, or complete a request to keep a record here."))
                .font(.subheadline).foregroundStyle(Theme.Colors.textSecondary).multilineTextAlignment(.center)
        }.frame(maxWidth: .infinity).padding(.vertical, 42).padding(.horizontal, 20)
    }

    private func memberName(_ id: String) -> String {
        appState.workspaceMembers.first { $0.id == id }?.name ?? DisplayName.of(id, in: appState.organization)
    }
}

struct RequestListRow: View {
    @Environment(\.locale) private var locale
    let card: DecisionCard
    let person: String
    var isSent = false
    var awaitingDelivery = false
    private var relativeTime: String {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .short
        formatter.locale = locale
        let minutes = max(1, Int(Date().timeIntervalSince(card.createdAt) / 60))
        if minutes < 60 { return formatter.localizedString(from: DateComponents(minute: -minutes)) }
        if minutes < 1440 { return formatter.localizedString(from: DateComponents(hour: -(minutes / 60))) }
        return formatter.localizedString(from: DateComponents(day: -(minutes / 1440)))
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack(spacing: 8) {
                Text(String(person.prefix(1))).font(.caption.weight(.semibold))
                    .foregroundStyle(Theme.Colors.accent).frame(width: 26, height: 26)
                    .background(Theme.Colors.accent.opacity(0.09), in: Circle())
                Text(isSent ? String(localized: "To \(person)") : person)
                    .font(.subheadline).foregroundStyle(Theme.Colors.textSecondary).lineLimit(1)
                Spacer(minLength: 4)
                Text(relativeTime).font(.caption).foregroundStyle(Theme.Colors.textTertiary)
            }
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                Text(card.title).font(.system(.body, weight: .semibold)).lineLimit(2)
                    .foregroundStyle(Theme.Colors.textPrimary).frame(maxWidth: .infinity, alignment: .leading)
                Image(systemName: "chevron.right").font(.caption.weight(.medium)).foregroundStyle(Theme.Colors.textTertiary)
            }
            Text(card.summary).font(.subheadline).lineLimit(2).foregroundStyle(Theme.Colors.textSecondary)
            HStack(spacing: 10) {
                Text(awaitingDelivery ? String(localized: "Waiting for workspace sync") : (card.isPending ? card.type.label : card.status.label))
                    .foregroundStyle(Theme.Colors.textSecondary)
                if card.priority == .urgent || card.priority == .high {
                    Circle().fill(card.priority == .urgent ? Theme.Colors.reject : Theme.Colors.accent).frame(width: 5, height: 5)
                    Text(card.priorityLabel).foregroundStyle(card.priority == .urgent ? Theme.Colors.reject : Theme.Colors.accent)
                }
                Spacer()
                if let source = card.sourceApp { Text(source.capitalized).foregroundStyle(Theme.Colors.textTertiary) }
            }.font(.caption.weight(.medium))
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}
