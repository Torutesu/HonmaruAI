import SwiftUI

/// What the card was made from, shown the way it looked in the tool it came out
/// of.
///
/// The card is a rewrite. Being able to open the thing it rewrote is what makes
/// it checkable rather than something you have to take on faith — the same
/// reason the translation badge exposes the original.
struct SourceSheet: View {
    let app: String
    let detail: String?
    let card: DecisionCard

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                    header
                    Divider().overlay(Theme.Colors.border)
                    body(for: app)
                    footnote
                }
                .padding(Theme.Spacing.screen)
            }
            .background(Theme.Colors.background)
            .navigationTitle(app)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("閉じる") { dismiss() }
                }
            }
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            if let detail {
                Text(detail)
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(Theme.Colors.textPrimary)
            }
            Text("\(card.senderName) · \(DateFormatting.relative(card.createdAt))")
                .font(Theme.TypeScale.caption)
                .foregroundStyle(Theme.Colors.textTertiary)
        }
    }

    /// Each tool gets the shape people recognise it by — a chat line, a page
    /// with properties, an email header, a calendar block.
    @ViewBuilder
    private func body(for app: String) -> some View {
        switch app.lowercased() {
        case "slack":
            chatLine
        case "gmail", "mail":
            email
        case "notion":
            page
        case "google calendar", "calendar":
            event
        default:
            record
        }
    }

    private var originalText: String {
        card.originalBody ?? card.summary
    }

    private var chatLine: some View {
        HStack(alignment: .top, spacing: 10) {
            SenderAvatar(name: card.senderName, diameter: 32)
            VStack(alignment: .leading, spacing: 4) {
                Text(card.senderName)
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(Theme.Colors.textPrimary)
                Text(originalText)
                    .font(.system(size: 15))
                    .foregroundStyle(Theme.Colors.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private var email: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            field("差出人", "\(card.senderName) <\(handle)@example.com>")
            field("宛先", "toru@honmaru.jp")
            field("件名", detail ?? card.title)
            Text(originalText)
                .font(.system(size: 15))
                .foregroundStyle(Theme.Colors.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, Theme.Spacing.xs)
        }
    }

    private var page: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            field("担当", card.senderName)
            field("状態", card.isPending ? "未対応" : card.status.label)
            field("更新", DateFormatting.relative(card.createdAt))
            Text(originalText)
                .font(.system(size: 15))
                .foregroundStyle(Theme.Colors.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, Theme.Spacing.xs)
        }
    }

    private var event: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            field("参加者", "\(card.senderName), あなた")
            field("場所", "オンライン")
            Text(originalText)
                .font(.system(size: 15))
                .foregroundStyle(Theme.Colors.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var record: some View {
        Text(originalText)
            .font(.system(size: 15))
            .foregroundStyle(Theme.Colors.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
    }

    private func field(_ label: String, _ value: String) -> some View {
        HStack(alignment: .top, spacing: Theme.Spacing.sm) {
            Text(label)
                .font(.system(size: 12, design: .monospaced))
                .foregroundStyle(Theme.Colors.textTertiary)
                .frame(width: 56, alignment: .leading)
            Text(value)
                .font(.system(size: 14))
                .foregroundStyle(Theme.Colors.textPrimary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var handle: String {
        card.senderName.applyingTransform(.toLatin, reverse: false)?
            .applyingTransform(.stripDiacritics, reverse: false)?
            .lowercased()
            .replacingOccurrences(of: " ", with: ".") ?? "sender"
    }

    private var footnote: some View {
        Text("この画面はデモ用の再現です。実際の連携では元のツールが開きます。")
            .font(Theme.TypeScale.micro)
            .foregroundStyle(Theme.Colors.textTertiary)
            .padding(.top, Theme.Spacing.md)
    }
}
