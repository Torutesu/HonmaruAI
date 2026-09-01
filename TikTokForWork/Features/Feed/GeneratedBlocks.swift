import SwiftUI

/// Card body assembled from what the decision actually contains.
///
/// A decision about money needs the amount large enough to read at a glance; one
/// with a deadline needs the date; a choice needs its options side by side. So
/// the card is not one fixed layout — the blocks are picked per card from the
/// structured context the agent produced.
///
/// This is the visible half of the claim that the AI prepared the decision: two
/// cards in the same feed do not look the same, because they are not the same
/// question.
struct GeneratedBlocks: View {
    let card: DecisionCard

    var body: some View {
        let blocks = Self.blocks(for: card)

        if !blocks.isEmpty {
            VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                ForEach(blocks) { block in
                    switch block.kind {
                    case .amount:   amountBlock(block)
                    case .deadline: pill(block, icon: "clock", tint: Theme.Colors.interactive)
                    case .metric:   pill(block, icon: "chart.line.uptrend.xyaxis", tint: Theme.Colors.accent)
                    case .options:  optionsBlock(block)
                    }
                }
            }
        }
    }

    // MARK: - Blocks

    private func amountBlock(_ block: Block) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(block.label)
                .font(.system(size: 10, weight: .medium, design: .monospaced))
                .tracking(0.6)
                .foregroundStyle(Theme.Colors.textTertiary)
            Text(block.value)
                .font(.system(size: 26, weight: .semibold))
                .foregroundStyle(Theme.Colors.textPrimary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(Theme.Spacing.md)
        .background(Theme.Colors.surface)
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.card))
        .overlay {
            RoundedRectangle(cornerRadius: Theme.Radius.card)
                .strokeBorder(Theme.Colors.border, lineWidth: 1)
        }
    }

    private func pill(_ block: Block, icon: String, tint: Color) -> some View {
        HStack(spacing: 6) {
            Image(systemName: icon)
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(tint)
            Text(block.value)
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(Theme.Colors.textPrimary)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(tint.opacity(0.08))
        .clipShape(Capsule())
    }

    /// A choice is the one case where the card has to show both sides at once —
    /// picking between two things you cannot see next to each other is guesswork.
    private func optionsBlock(_ block: Block) -> some View {
        HStack(spacing: Theme.Spacing.sm) {
            ForEach(Array(block.options.enumerated()), id: \.offset) { _, option in
                Text(option)
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(Theme.Colors.textPrimary)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 12)
                    .background(Theme.Colors.background)
                    .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.card))
                    .overlay {
                        RoundedRectangle(cornerRadius: Theme.Radius.card)
                            .strokeBorder(Theme.Colors.interactive, lineWidth: 1)
                    }
            }
        }
    }

    // MARK: - Selection

    struct Block: Identifiable {
        enum Kind { case amount, deadline, metric, options }
        let id = UUID()
        let kind: Kind
        let label: String
        let value: String
        var options: [String] = []
    }

    /// Reads the agent's own `label: detail` segments. Nothing is inferred from
    /// the prose: if the agent did not state a fact, the card does not invent a
    /// block for it.
    static func blocks(for card: DecisionCard) -> [Block] {
        var blocks: [Block] = []

        for segment in card.context.components(separatedBy: "·") {
            let parts = segment.split(separator: ":", maxSplits: 1).map {
                $0.trimmingCharacters(in: .whitespacesAndNewlines)
            }
            guard parts.count == 2, !parts[1].isEmpty else { continue }
            let label = parts[0].lowercased()
            let value = parts[1]

            if label.contains("金額") || label.contains("amount") {
                // "¥500,000 / ¥120,000" is a choice wearing an amount label.
                let options = value.components(separatedBy: "/").map {
                    $0.trimmingCharacters(in: .whitespaces)
                }
                if options.count > 1 {
                    blocks.append(Block(kind: .options, label: parts[0], value: value, options: options))
                } else {
                    blocks.append(Block(kind: .amount, label: parts[0], value: value))
                }
            } else if label.contains("期限") || label.contains("deadline") {
                blocks.append(Block(kind: .deadline, label: parts[0], value: value))
            } else if label.contains("指標") || label.contains("metric") {
                blocks.append(Block(kind: .metric, label: parts[0], value: value))
            }
        }

        return blocks
    }
}
