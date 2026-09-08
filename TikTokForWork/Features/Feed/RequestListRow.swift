import SwiftUI

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
