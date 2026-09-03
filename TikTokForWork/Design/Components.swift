import SwiftUI

struct PageDots: View {
    let count: Int
    let index: Int

    var body: some View {
        HStack(spacing: 5) {
            ForEach(0..<count, id: \.self) { i in
                Capsule()
                    .fill(i == index ? Theme.Colors.textPrimary : Theme.Colors.textTertiary.opacity(0.45))
                    .frame(width: i == index ? 16 : 5, height: 5)
                    .animation(.easeOut(duration: 0.2), value: index)
            }
        }
    }
}

struct PrimaryButton: View {
    let title: String
    var enabled: Bool = true
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.system(size: 16, weight: .medium))
                .frame(maxWidth: .infinity)
                .frame(height: 48)
                .background(enabled ? Theme.Colors.textPrimary : Theme.Colors.surfaceRaised)
                .foregroundStyle(enabled ? Theme.Colors.background : Theme.Colors.textTertiary)
                .clipShape(Capsule())
        }
        .disabled(!enabled)
    }
}

struct GitHubPrimaryButton: View {
    let title: String
    var enabled: Bool = true
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Image("GitHubMark")
                    .resizable()
                    .scaledToFit()
                    .frame(width: 16, height: 16)
                Text(title)
                    .font(.system(size: 16, weight: .semibold))
            }
            .frame(maxWidth: .infinity)
            .frame(height: 48)
            .background(enabled ? Theme.Colors.issueGreen : Theme.Colors.surfaceRaised)
            .foregroundStyle(enabled ? Color.white : Theme.Colors.textTertiary)
            .clipShape(Capsule())
        }
        .disabled(!enabled)
    }
}

struct SecondaryAction: View {
    let title: String
    var tint: Color = Theme.Colors.textSecondary
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.system(size: 14))
                .foregroundStyle(tint)
                .frame(maxWidth: .infinity)
                .frame(height: 40)
        }
    }
}

struct ComposeBar: View {
    let placeholder: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                Image(systemName: "sparkle")
                    .font(.system(size: 14))
                    .foregroundStyle(Theme.Colors.accent)
                Text(placeholder)
                    .font(Theme.TypeScale.body)
                    .foregroundStyle(Theme.Colors.textTertiary)
                Spacer()
            }
            .padding(.horizontal, Theme.Spacing.md)
            .frame(height: 48)
            .background(Theme.Colors.surfaceRaised)
            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.input))
        }
    }
}

struct PrioritySlider: View {
    @Binding var priority: CardPriority

    private let levels: [CardPriority] = [.low, .medium, .high, .urgent]

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            HStack {
                Text("Priority")
                    .font(Theme.TypeScale.label)
                    .foregroundStyle(Theme.Colors.textTertiary)
                Spacer()
                Text(priorityLabel)
                    .font(Theme.TypeScale.label)
                    .foregroundStyle(priorityColor)
            }

            HStack(spacing: Theme.Spacing.sm) {
                ForEach(levels, id: \.self) { level in
                    Button {
                        withAnimation(.easeOut(duration: 0.15)) {
                            priority = level
                        }
                        Haptics.light()
                    } label: {
                        VStack(spacing: 6) {
                            Capsule()
                                .fill(level == priority ? priorityColor(for: level) : Theme.Colors.surfaceRaised)
                                .frame(height: 4)
                            Text(shortLabel(for: level))
                                .font(Theme.TypeScale.micro)
                                .foregroundStyle(level == priority ? Theme.Colors.textPrimary : Theme.Colors.textTertiary)
                        }
                        .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    private var priorityLabel: String {
        switch priority {
        case .low: "Low"
        case .medium: "Medium"
        case .high: "High"
        case .urgent: "Urgent"
        }
    }

    private var priorityColor: Color {
        priorityColor(for: priority)
    }

    private func priorityColor(for level: CardPriority) -> Color {
        switch level {
        case .low: Theme.Colors.textTertiary
        case .medium: Color(hex: 0xD4D4D4)
        case .high: Theme.Colors.interactive
        case .urgent: Theme.Colors.reject
        }
    }

    private func shortLabel(for level: CardPriority) -> String {
        switch level {
        case .low: "Low"
        case .medium: String(localized: "Med")
        case .high: "High"
        case .urgent: String(localized: "Now")
        }
    }
}

struct ToolCallChip: View {
    let call: AgentToolCall

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: call.icon)
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(Theme.Colors.accent)
                .frame(width: 16)

            VStack(alignment: .leading, spacing: 2) {
                Text(call.label)
                    .font(Theme.TypeScale.label)
                    .foregroundStyle(Theme.Colors.textPrimary)
                Text(call.detail)
                    .font(Theme.TypeScale.micro)
                    .foregroundStyle(Theme.Colors.textTertiary)
                    .lineLimit(2)
            }

            Spacer(minLength: 0)
        }
        .padding(.horizontal, Theme.Spacing.md)
        .padding(.vertical, Theme.Spacing.sm)
        .background(Theme.Colors.surfaceRaised)
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
    }
}

struct LabelChip: View {
    let text: String

    var body: some View {
        Text(text)
            .font(Theme.TypeScale.micro)
            .foregroundStyle(Theme.Colors.textSecondary)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(Theme.Colors.surfaceRaised)
            .clipShape(Capsule())
    }
}

// MARK: - Context insights

struct ContextInsight: Identifiable {
    enum Kind {
        case deadline
        case metric
        case scope
        case channel
        case action
        case link
        case routing
        case general

        var icon: String {
            switch self {
            case .deadline: "calendar"
            case .metric: "chart.line.uptrend.xyaxis"
            case .scope: "square.stack.3d.up"
            case .channel: "antenna.radiowaves.left.and.right"
            case .action: "bolt.fill"
            case .link: "link"
            case .routing: "arrow.triangle.branch"
            case .general: "sparkle"
            }
        }

        var tint: Color {
            switch self {
            case .deadline: Color(hex: 0xFBBF24)
            case .metric: Theme.Colors.reject
            case .scope: Theme.Colors.accent
            case .channel: Color(hex: 0x38BDF8)
            case .action: Theme.Colors.approve
            case .link: Theme.Colors.accent
            case .routing: Theme.Colors.textSecondary
            case .general: Theme.Colors.textTertiary
            }
        }
    }

    let id: String
    let kind: Kind
    let label: String?
    let value: String
}

enum ContextInsights {
    static func parse(_ raw: String) -> [ContextInsight] {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return [] }

        let segments = trimmed
            .replacingOccurrences(of: " · ", with: "|")
            .components(separatedBy: CharacterSet(charactersIn: "·|\n"))
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }

        let items = segments.isEmpty ? [trimmed] : segments
        var insights = items.map { insight(from: $0) }

        if insights.count == 1, insights[0].kind == .general {
            let sentences = trimmed
                .components(separatedBy: ". ")
                .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                .filter { !$0.isEmpty }
            if sentences.count > 1 {
                insights = sentences.map { insight(from: $0) }
            }
        }

        return insights
    }

    private static func insight(from segment: String) -> ContextInsight {
        let cleaned = segment.trimmingCharacters(in: .whitespacesAndNewlines)
            .trimmingCharacters(in: CharacterSet(charactersIn: "."))

        if let colon = cleaned.firstIndex(of: ":") {
            let label = String(cleaned[..<colon]).trimmingCharacters(in: .whitespacesAndNewlines)
            let value = String(cleaned[cleaned.index(after: colon)...])
                .trimmingCharacters(in: .whitespacesAndNewlines)
            if !label.isEmpty, !value.isEmpty, label.count <= 24 {
                return ContextInsight(
                    id: cleaned,
                    kind: classify(label: label, value: value),
                    label: label.capitalized,
                    value: value
                )
            }
        }

        return ContextInsight(
            id: cleaned,
            kind: classify(label: nil, value: cleaned),
            label: nil,
            value: cleaned
        )
    }

    private static func classify(label: String?, value: String) -> ContextInsight.Kind {
        let haystack = "\(label ?? "") \(value)".lowercased()

        // Matching is by keyword, so every language the app ships in needs its
        // own terms here. Without the Japanese ones a localized context line
        // falls through to .general and silently loses its icon.
        if haystack.contains("from ") && haystack.contains("routed") { return .routing }
        if haystack.contains("deadline") || haystack.contains("friday") || haystack.contains("monday")
            || haystack.contains("tomorrow") || haystack.contains("due") || haystack.contains("before")
            || haystack.contains("eod") || haystack.contains("by ")
            || haystack.contains("期限") || haystack.contains("締切") || haystack.contains("金曜")
            || haystack.contains("月曜") || haystack.contains("明日") || haystack.contains("本日")
            || haystack.contains("今日") { return .deadline }
        if haystack.contains("%") || haystack.contains("p95") || haystack.contains("p99")
            || haystack.contains("latency") || haystack.contains("regression")
            || haystack.contains("ms") || haystack.contains("up ") || haystack.contains("down ")
            || haystack.contains("指標") || haystack.contains("遅延") || haystack.contains("悪化")
            // Money is the metric a one-person business actually watches.
            || haystack.contains("amount") || haystack.contains("金額")
            || haystack.contains("¥") || haystack.contains("円") { return .metric }
        if haystack.contains("channel") || haystack.contains("チャンネル") { return .channel }
        if haystack.contains("production") || haystack.contains("staging") || haystack.contains("local")
            || haystack.contains("scope") || haystack.contains("split") || haystack.contains("environment")
            || haystack.contains("範囲") || haystack.contains("本番") || haystack.contains("ステージング") {
            return .scope
        }
        if haystack.contains("pr #") || haystack.contains("hotfix") || haystack.contains("branch")
            || haystack.contains("action") || haystack.contains("fix") || haystack.contains("deploy")
            || haystack.contains("対応") || haystack.contains("修正") || haystack.contains("ブランチ")
            || haystack.contains("デプロイ") {
            return .action
        }
        if haystack.contains("http") || haystack.contains("github.com") || haystack.contains("#") {
            return .link
        }

        if let label {
            switch label.lowercased() {
            case "deadline", "due", "when": return .deadline
            case "metric", "impact", "change": return .metric
            case "scope", "area", "surface": return .scope
            case "channel", "channels": return .channel
            case "action", "next", "recommendation": return .action
            default: break
            }
        }

        return .general
    }
}

struct ContextInsightView: View {
    let context: String
    var compact: Bool = false

    private var insights: [ContextInsight] {
        ContextInsights.parse(context)
    }

    var body: some View {
        if insights.isEmpty {
            EmptyView()
        } else if compact {
            Text(compactText)
                .font(Theme.TypeScale.caption)
                .foregroundStyle(Theme.Colors.textTertiary)
                .lineSpacing(4)
                .fixedSize(horizontal: false, vertical: true)
        } else {
            VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                ForEach(insights) { insight in
                    detailRow(insight)
                }
            }
        }
    }

    private var compactText: String {
        insights.map { insight in
            if let label = insight.label {
                return "\(label): \(insight.value)"
            }
            return insight.value
        }
        .joined(separator: " · ")
    }

    private func detailRow(_ insight: ContextInsight) -> some View {
        HStack(alignment: .top, spacing: Theme.Spacing.md) {
            if let label = insight.label {
                Text(label)
                    .font(Theme.TypeScale.caption)
                    .foregroundStyle(Theme.Colors.textTertiary)
                    .frame(width: 72, alignment: .leading)
            }

            Text(insight.value)
                .font(Theme.TypeScale.caption)
                .foregroundStyle(Theme.Colors.textSecondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}
