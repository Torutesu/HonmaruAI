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

struct RequestHistoryView: View {
    @EnvironmentObject private var appState: AppState
    var body: some View { RequestHistoryContent(service: appState.cardService) }
}

private struct RequestHistoryContent: View {
    @ObservedObject var service: DecisionCardService
    @EnvironmentObject private var appState: AppState
    @State private var queue: RequestQueue = .sent
    @State private var search = ""
    private var cards: [DecisionCard] {
        guard let userID = appState.currentUser?.id else { return [] }
        return service.allCards(for: userID).filter {
            let belongs = queue == .sent ? $0.senderUserID == userID && $0.sourceDetail != "decision-result" : $0.recipientUserID == userID && !$0.isPending
            return belongs && (search.isEmpty || [$0.title, $0.summary].joined(separator: " ").localizedCaseInsensitiveContains(search))
        }
    }
    var body: some View {
        VStack(spacing: 0) {
            Picker("History", selection: $queue) { Text("Sent").tag(RequestQueue.sent); Text("Completed").tag(RequestQueue.completed) }
                .pickerStyle(.segmented).padding(.horizontal, 20).padding(.vertical, 12)
            List {
                if cards.isEmpty { Text("No matching requests").foregroundStyle(Theme.Colors.textSecondary) }
                ForEach(cards) { card in
                    NavigationLink { RequestDetailView(cardID: card.id, service: service) } label: {
                        RequestListRow(card: card, person: name(queue == .sent ? card.recipientUserID : card.senderUserID), isSent: queue == .sent, awaitingDelivery: service.awaitingDeliveryIDs.contains(card.id))
                            .padding(.vertical, 8)
                    }
                }
            }.listStyle(.plain)
        }
        .background(Theme.Colors.background)
        .navigationTitle("History").navigationBarTitleDisplayMode(.inline)
        .searchable(text: $search, prompt: "Search requests or people")
    }
    private func name(_ id: String) -> String { appState.workspaceMembers.first { $0.id == id }?.name ?? DisplayName.of(id, in: appState.organization) }
}
