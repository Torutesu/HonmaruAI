import SwiftUI

/// How the feed is doing for this team: whether decisions move, what gets
/// declined, where cards come from, and what the AI got wrong. The numbers
/// are the Worker's, from the cards themselves.
struct InsightsView: View {
    @EnvironmentObject private var appState: AppState
    @State private var days = 14
    @State private var metrics: InsightsService.Metrics?
    @State private var message: String?
    @State private var isLoading = true

    private let windows = [7, 14, 30]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                Picker(String(localized: "Window"), selection: $days) {
                    ForEach(windows, id: \.self) { d in
                        Text(String(localized: "\(d) days")).tag(d)
                    }
                }
                .pickerStyle(.segmented)

                if isLoading {
                    ProgressView().frame(maxWidth: .infinity).padding(.top, Theme.Spacing.xl)
                } else if let message {
                    Text(message)
                        .font(Theme.TypeScale.body)
                        .foregroundStyle(Theme.Colors.textSecondary)
                        .padding(.top, Theme.Spacing.xl)
                } else if let m = metrics {
                    stats(m)
                    section(String(localized: "Cards per day")) { perDay(m) }
                    section(String(localized: "Right now")) { rightNow(m) }
                    if !m.bySource.isEmpty {
                        section(String(localized: "Where cards come from")) {
                            bars(m.bySource.map { ($0.label == "You" ? String(localized: "You") : $0.label, $0.count) })
                        }
                    }
                    if !m.byAction.isEmpty {
                        section(String(localized: "What was decided")) {
                            bars(m.byAction.map { (actionWord($0.label), $0.count) })
                        }
                    }
                    section(String(localized: "What your AI got wrong")) {
                        if m.feedback.reasons.isEmpty {
                            Text(String(localized: "Nobody has flagged a card in this window. \"Is this card wrong?\" sits under every card."))
                                .font(Theme.TypeScale.caption)
                                .foregroundStyle(Theme.Colors.textTertiary)
                        } else {
                            bars(m.feedback.reasons.sorted { $0.value > $1.value }.map { (reasonWord($0.key), $0.value) })
                        }
                    }
                }
            }
            .padding(.horizontal, Theme.Spacing.md)
            .padding(.top, Theme.Spacing.md)
            .padding(.bottom, Theme.Spacing.xxl)
        }
        .appBackground()
        .navigationTitle(String(localized: "Insights"))
        .navigationBarTitleDisplayMode(.inline)
        .task(id: days) { await load() }
    }

    private func load() async {
        isLoading = true
        message = nil
        defer { isLoading = false }
        guard let base = appState.backendBaseURL, let orgId = appState.currentUser?.teamID, !orgId.isEmpty else {
            message = String(localized: "Sign in to see how your feed is doing.")
            return
        }
        do {
            metrics = try await InsightsService.metrics(orgId: orgId, days: days, backendBaseURL: base)
        } catch {
            message = error.localizedDescription
        }
    }

    // MARK: - Pieces

    private func stats(_ m: InsightsService.Metrics) -> some View {
        HStack(spacing: 0) {
            stat(String(m.cards), String(localized: "cards"))
            divider
            stat(duration(m.medianMinutesToDecide), String(localized: "median wait"))
            divider
            stat(m.declineRate.map { "\(Int(($0 * 100).rounded()))%" } ?? "—", String(localized: "declined"))
        }
        .background(Theme.Colors.background)
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.image, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Theme.Radius.image, style: .continuous).stroke(Theme.Colors.border, lineWidth: 1))
    }

    private var divider: some View {
        Rectangle().fill(Theme.Colors.border).frame(width: 1)
    }

    private func stat(_ value: String, _ label: String) -> some View {
        VStack(spacing: Theme.Spacing.xs) {
            Text(value)
                .font(.system(size: 22, weight: .bold))
                .foregroundStyle(Theme.Colors.textPrimary)
            Text(label.uppercased())
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(Theme.Colors.textTertiary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 14)
    }

    private func section<Content: View>(_ title: String, @ViewBuilder _ content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            Text(title.uppercased())
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(Theme.Colors.textTertiary)
                .padding(.leading, Theme.Spacing.xs)
            content()
        }
        .padding(.top, Theme.Spacing.sm)
    }

    /// One bar per day, one hue; a zero day is a hairline so the quiet days
    /// are still days.
    private func perDay(_ m: InsightsService.Metrics) -> some View {
        let peak = max(1, m.created.map(\.count).max() ?? 1)
        return VStack(spacing: 0) {
            HStack(alignment: .bottom, spacing: 3) {
                ForEach(m.created, id: \.day) { d in
                    RoundedRectangle(cornerRadius: 2, style: .continuous)
                        .fill(d.count == 0 ? Theme.Colors.border : Theme.Colors.ctaFill)
                        .frame(maxWidth: .infinity)
                        .frame(height: max(2, CGFloat(d.count) / CGFloat(peak) * 80))
                        .accessibilityLabel(Text("\(d.day): \(d.count)"))
                }
            }
            .frame(height: 88, alignment: .bottom)
            .padding(.horizontal, 12)
            .padding(.top, 8)
            HStack {
                Text(m.created.first.map { String($0.day.suffix(5)) } ?? "")
                Spacer()
                Text(m.created.last.map { String($0.day.suffix(5)) } ?? "")
            }
            .font(.system(size: 10, design: .monospaced))
            .foregroundStyle(Theme.Colors.textTertiary)
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
        }
        .background(Theme.Colors.background)
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.card, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Theme.Radius.card, style: .continuous).stroke(Theme.Colors.border, lineWidth: 1))
    }

    private func rightNow(_ m: InsightsService.Metrics) -> some View {
        VStack(spacing: 0) {
            numberRow(String(localized: "Waiting on someone"), m.pending)
            Divider().overlay(Theme.Colors.border)
            numberRow(String(localized: "Decided in this window"), m.decided)
            Divider().overlay(Theme.Colors.border)
            numberRow(String(localized: "Nudged"), m.nudges)
            Divider().overlay(Theme.Colors.border)
            numberRow(String(localized: "Notes to yourself"), m.selfAddressed)
        }
        .background(Theme.Colors.background)
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.image, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Theme.Radius.image, style: .continuous).stroke(Theme.Colors.border, lineWidth: 1))
    }

    private func numberRow(_ title: String, _ value: Int) -> some View {
        HStack {
            Text(title).font(.system(size: 15)).foregroundStyle(Theme.Colors.textPrimary)
            Spacer()
            Text(String(value)).font(.system(size: 14)).foregroundStyle(Theme.Colors.textTertiary)
        }
        .padding(.horizontal, Theme.Spacing.md)
        .padding(.vertical, 13)
    }

    /// One hue, thin marks, the number beside each bar.
    private func bars(_ rows: [(String, Int)]) -> some View {
        let peak = max(1, rows.map(\.1).max() ?? 1)
        return VStack(spacing: Theme.Spacing.sm) {
            ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                HStack(spacing: 10) {
                    Text(row.0)
                        .font(.system(size: 13.5))
                        .foregroundStyle(Theme.Colors.textPrimary)
                        .lineLimit(1)
                        .frame(width: 120, alignment: .leading)
                    GeometryReader { geo in
                        ZStack(alignment: .leading) {
                            Capsule().fill(Theme.Colors.surfaceRaised)
                            Capsule().fill(Theme.Colors.ctaFill)
                                .frame(width: max(4, geo.size.width * CGFloat(row.1) / CGFloat(peak)))
                        }
                    }
                    .frame(height: 8)
                    Text(String(row.1))
                        .font(.system(size: 13.5).monospacedDigit())
                        .foregroundStyle(Theme.Colors.textSecondary)
                        .frame(width: 32, alignment: .trailing)
                }
                .accessibilityElement(children: .combine)
            }
        }
        .padding(.horizontal, Theme.Spacing.xs)
    }

    private func duration(_ minutes: Double?) -> String {
        guard let minutes else { return "—" }
        if minutes < 60 { return String(localized: "\(Int(minutes.rounded()))m") }
        if minutes < 60 * 24 { return String(localized: "\(Int((minutes / 60).rounded()))h") }
        return String(localized: "\(Int((minutes / 1440).rounded()))d")
    }

    private func actionWord(_ action: String) -> String {
        switch action {
        case "approve": String(localized: "Approved")
        case "decline": String(localized: "Declined")
        case "revise": String(localized: "Revision asked")
        case "delegate": String(localized: "Delegated")
        case "reply": String(localized: "Replied")
        default: action
        }
    }

    private func reasonWord(_ reason: String) -> String {
        InsightsService.FlagReason(rawValue: reason)?.label ?? String(localized: "Other")
    }
}

#Preview {
    NavigationStack { InsightsView().environmentObject(AppState()) }
}
