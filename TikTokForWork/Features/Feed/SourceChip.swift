import SwiftUI

/// Where the decision came from: Slack, Notion, Gmail, a calendar invite.
///
/// A card is a rewrite of someone else's message, and a rewrite you cannot
/// trace is just an assertion. The chip names the tool and the place inside it,
/// so the work is findable again.
struct SourceChip: View {
    let app: String
    let detail: String?

    var body: some View {
        HStack(spacing: 5) {
            Image(systemName: symbol)
                .font(.system(size: 10, weight: .semibold))
            Text(label)
                .font(.system(size: 10, weight: .medium, design: .monospaced))
                .tracking(0.4)
                .lineLimit(1)
        }
        .foregroundStyle(Theme.Colors.textSecondary)
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(Theme.Colors.surface)
        .clipShape(Capsule())
        .overlay { Capsule().strokeBorder(Theme.Colors.border, lineWidth: 1) }
    }

    private var label: String {
        guard let detail, !detail.isEmpty else { return app }
        return "\(app) · \(detail)"
    }

    /// SF Symbols stand in for brand marks. Shipping the real logos would mean
    /// bundling trademarks we have no licence to redistribute.
    private var symbol: String {
        switch app.lowercased() {
        case "slack":            "number.square"
        case "notion":           "doc.text"
        case "gmail", "mail":    "envelope"
        case "google calendar",
             "calendar":         "calendar"
        case "github":           "chevron.left.forwardslash.chevron.right"
        case "freee":            "yensign.circle"
        default:                 "app.badge"
        }
    }
}

#Preview {
    VStack(alignment: .leading, spacing: 8) {
        SourceChip(app: "Slack", detail: "#north-inc")
        SourceChip(app: "Notion", detail: "Q3 受注計画")
        SourceChip(app: "Gmail", detail: "請求書の件")
        SourceChip(app: "Google Calendar", detail: "金曜 15:00")
    }
    .padding()
    .background(Theme.Colors.background)
}
