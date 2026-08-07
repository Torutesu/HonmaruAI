import SwiftUI

struct HistoryView: View {
    @EnvironmentObject private var appState: AppState
    @Environment(\.dismiss) private var dismiss
    @State private var cards: [DecisionCard] = []

    var body: some View {
        NavigationStack {
            Group {
                if cards.isEmpty {
                    emptyState
                } else {
                    ScrollView {
                        VStack(alignment: .leading, spacing: Theme.Spacing.xl) {
                            ForEach(sections, id: \.title) { section in
                                VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                                    Text(section.title)
                                        .font(Theme.TypeScale.micro)
                                        .foregroundStyle(Theme.Colors.textTertiary)
                                        .textCase(.uppercase)
                                        .tracking(0.8)

                                    ForEach(section.cards) { card in
                                        row(card)
                                    }
                                }
                            }
                        }
                        .padding(Theme.Spacing.screen)
                    }
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Theme.Colors.background)
            .navigationTitle("History")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                        .foregroundStyle(Theme.Colors.textSecondary)
                }
            }
        }
        .presentationBackground(Theme.Colors.background)
        .onAppear(perform: refresh)
    }

    private struct DaySection {
        let title: String
        let cards: [DecisionCard]
    }

    private var sections: [DaySection] {
        let calendar = Calendar.current
        let grouped = Dictionary(grouping: cards) { calendar.startOfDay(for: $0.createdAt) }
        return grouped.keys.sorted(by: >).map { day in
            DaySection(title: dayLabel(day), cards: grouped[day] ?? [])
        }
    }

    private func dayLabel(_ day: Date) -> String {
        let calendar = Calendar.current
        if calendar.isDateInToday(day) { return "Today" }
        if calendar.isDateInYesterday(day) { return "Yesterday" }
        return day.formatted(.dateTime.month(.abbreviated).day())
    }

    private func row(_ card: DecisionCard) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
            HStack(spacing: Theme.Spacing.sm) {
                Circle()
                    .fill(statusColor(card.status))
                    .frame(width: 6, height: 6)
                Text(card.title)
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(Theme.Colors.textPrimary)
                    .lineLimit(2)
                Spacer()
                Text(DateFormatting.relative(card.createdAt))
                    .font(Theme.TypeScale.micro)
                    .foregroundStyle(Theme.Colors.textTertiary)
            }

            Text("\(card.status.label) · from \(card.senderName)")
                .font(Theme.TypeScale.label)
                .foregroundStyle(Theme.Colors.textTertiary)

            if let issueURL = card.githubIssueURL, let url = URL(string: issueURL) {
                Link(destination: url) {
                    HStack(spacing: 4) {
                        Text(card.githubIssueNumber.map { "Issue #\($0)" } ?? "View on GitHub")
                        Image(systemName: "arrow.up.right")
                            .font(.system(size: 9))
                    }
                    .font(Theme.TypeScale.label)
                    .foregroundStyle(Theme.Colors.accent)
                }
            }
        }
        .padding(Theme.Spacing.md)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.Colors.surface)
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))
    }

    private func statusColor(_ status: CardStatus) -> Color {
        switch status {
        case .approved: Theme.Colors.approve
        case .completed: Theme.Colors.textTertiary
        case .rejected: Theme.Colors.reject
        case .revised: Color(hex: 0xFBBF24)
        case .delegated: Theme.Colors.accent
        case .pending: Theme.Colors.textSecondary
        }
    }

    private var emptyState: some View {
        VStack(spacing: Theme.Spacing.sm) {
            Text("No decisions yet")
                .font(.system(size: 17, weight: .medium))
                .foregroundStyle(Theme.Colors.textPrimary)
            Text("Cards you approve, decline, revise, or delegate land here")
                .font(Theme.TypeScale.caption)
                .foregroundStyle(Theme.Colors.textTertiary)
                .multilineTextAlignment(.center)
        }
        .padding(Theme.Spacing.screen)
    }

    private func refresh() {
        guard let userID = appState.currentUser?.id else { return }
        cards = appState.cardService.cards(for: userID).filter { !$0.isPending }
    }
}

#Preview {
    HistoryView()
        .environmentObject(AppState())
}
