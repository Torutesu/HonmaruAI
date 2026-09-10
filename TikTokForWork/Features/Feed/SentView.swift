import SwiftUI

/// What you asked of everybody else, and how long it has been sitting there.
///
/// The feed answers one question — what is waiting on me — and the store is
/// keyed to answer it. Nothing on a phone has ever asked the other one, which
/// is why the SLA work shipped as a chip on a card and no more: there was
/// nowhere to see that a decision you are waiting on is five days old, and
/// nowhere to ask again from.
struct SentView: View {
    @EnvironmentObject private var appState: AppState
    @State private var nudged: Set<String> = []

    private var cards: [DecisionCard] {
        guard let me = appState.currentUser?.id else { return [] }
        return appState.cardService.sent(by: me)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                if cards.isEmpty {
                    Text(String(localized: "Nothing sent yet. Tell your AI something."))
                        .font(.system(size: 14))
                        .foregroundStyle(Theme.Colors.textSecondary)
                        .padding(.top, Theme.Spacing.lg)
                } else {
                    ForEach(cards) { card in
                        row(card)
                    }
                }
            }
            .padding(Theme.Spacing.md)
        }
        .navigationTitle(Text("Sent by you"))
    }

    private func row(_ card: DecisionCard) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
            Text(card.title)
                .font(.system(size: 15, weight: .medium))
                .foregroundStyle(Theme.Colors.textPrimary)
                .multilineTextAlignment(.leading)

            HStack(spacing: Theme.Spacing.sm) {
                Text(status(for: card))
                    .font(Theme.TypeScale.micro)
                    .foregroundStyle(card.status == .pending ? Theme.Colors.textTertiary : Theme.Colors.interactive)
                Spacer()
                // Only a pending one can be hurried, and only once from here:
                // a button that can be pressed repeatedly is a button that
                // sends somebody five notifications.
                if card.status == .pending {
                    Button(nudged.contains(card.id) ? String(localized: "Asked") : String(localized: "Nudge")) {
                        Task {
                            await appState.webSocketService.nudge(cardID: card.id)
                            nudged.insert(card.id)
                        }
                    }
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(nudged.contains(card.id) ? Theme.Colors.textTertiary : Theme.Colors.interactive)
                    .disabled(nudged.contains(card.id))
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(Theme.Spacing.md)
        .background(Theme.Colors.background)
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.image))
        .overlay {
            RoundedRectangle(cornerRadius: Theme.Radius.image)
                .strokeBorder(Theme.Colors.border, lineWidth: 1)
        }
    }

    /// Who it is waiting on, or what they said. Never the id they sign in
    /// with: for an email account that is the whole address.
    private func status(for card: DecisionCard) -> String {
        let who = DisplayName.short(card.recipientUserID)
        guard card.status == .pending else {
            return card.decision?.action ?? String(localized: "Decided")
        }
        let days = Calendar.current.dateComponents([.day], from: card.createdAt, to: Date()).day ?? 0
        if days >= 1 {
            return "\(String(localized: "Waiting on")) \(who) · \(days)d"
        }
        return "\(String(localized: "Waiting on")) \(who)"
    }
}
