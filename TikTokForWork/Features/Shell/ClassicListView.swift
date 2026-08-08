import SwiftUI

/// A4 — the Classic surface: a deliberate Slack iOS clone standing in for the
/// old way of working, so the difference from the Cards surface is visible
/// side by side.
///
/// It intentionally uses Slack's palette rather than ours, and its rows are
/// fixtures rather than live data — the point is the shape of the old surface,
/// not its contents. Layout follows `docs/figma/classic-slack-rebuild.js`,
/// which is the design of record for this screen.
///
/// Inter is substituted by the system face, as `docs/design-system.md` allows.
struct ClassicListView: View {
    /// Tapping any row returns to the decision the old surface buried.
    var onOpenCards: () -> Void = {}

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                workspaceHeader
                searchPill

                sectionHeader("Channels")
                ForEach(Fixtures.channels) { row($0) }

                sectionHeader("Direct messages")
                ForEach(Fixtures.directMessages) { row($0) }

                sectionHeader("Apps")
                ForEach(Fixtures.apps) { row($0) }
            }
            .padding(.bottom, Theme.Spacing.sm)
        }
        .background(Slack.canvas)
    }

    // MARK: - Chrome

    private var workspaceHeader: some View {
        HStack(spacing: 8) {
            HStack(spacing: 4) {
                Text("Honmaru HQ")
                    .font(.system(size: 19, weight: .heavy))
                    .foregroundStyle(Slack.ink)
                Text("▾")
                    .font(.system(size: 11))
                    .foregroundStyle(Slack.muted)
            }
            Spacer()
            iconCircle("line.3.horizontal")
            iconCircle("square.and.pencil")
        }
        .padding(.horizontal, 16)
        .padding(.top, 8)
        .padding(.bottom, 4)
    }

    private func iconCircle(_ systemName: String) -> some View {
        Image(systemName: systemName)
            .font(.system(size: 13))
            .foregroundStyle(Slack.ink)
            .frame(width: 32, height: 32)
            .overlay { Circle().strokeBorder(Color(hex: 0xDDDDDD), lineWidth: 1) }
    }

    private var searchPill: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(Slack.muted)
            Text("Jump to or search…")
                .font(.system(size: 13.5))
                .foregroundStyle(Slack.muted)
            Spacer()
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .background(Color(hex: 0xF2F2F2))
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .padding(.horizontal, 16)
        .padding(.top, 4)
        .padding(.bottom, 2)
    }

    private func sectionHeader(_ label: String) -> some View {
        HStack(spacing: 5) {
            Text("▼")
                .font(.system(size: 8))
                .foregroundStyle(Slack.muted)
            Text(label)
                .font(.system(size: 12.5, weight: .semibold))
                .foregroundStyle(Slack.muted)
            Spacer()
        }
        .padding(.horizontal, 16)
        .padding(.top, 13)
        .padding(.bottom, 3)
    }

    // MARK: - Rows

    private func row(_ item: Fixtures.Row) -> some View {
        Button(action: onOpenCards) {
            HStack(spacing: 10) {
                switch item.lead {
                case .hash:
                    Text("#")
                        .font(.system(size: 16))
                        .foregroundStyle(Slack.muted)
                        .frame(width: 28, height: 28)
                case let .avatar(letter, color, online):
                    avatar(letter, color: color, online: online)
                }

                VStack(alignment: .leading, spacing: 1) {
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text(item.name)
                            .font(.system(size: 14.5, weight: item.isUnread ? .heavy : .regular))
                            .foregroundStyle(Slack.ink)
                        Spacer()
                        Text(item.time)
                            .font(.system(size: 10.5))
                            .foregroundStyle(Slack.muted)
                    }
                    Text(item.preview)
                        .font(.system(size: 12, weight: item.isUnread ? .medium : .regular))
                        .foregroundStyle(item.isUnread ? Slack.ink : Slack.muted)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }

                if item.badge > 0 {
                    Text("\(item.badge)")
                        .font(.system(size: 10.5, weight: .bold))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(Slack.badge)
                        .clipShape(Capsule())
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 6)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func avatar(_ letter: String, color: UInt, online: Bool) -> some View {
        RoundedRectangle(cornerRadius: 6)
            .fill(Color(hex: color))
            .frame(width: 28, height: 28)
            .overlay {
                Text(letter)
                    .font(.system(size: 12.5, weight: .bold))
                    .foregroundStyle(.white)
            }
            .overlay(alignment: .bottomTrailing) {
                Circle()
                    .fill(online ? Slack.presence : Slack.canvas)
                    .frame(width: 11, height: 11)
                    .overlay {
                        Circle().strokeBorder(
                            online ? Slack.canvas : Slack.muted,
                            lineWidth: online ? 2 : 1.5
                        )
                    }
                    .offset(x: 3, y: 3)
            }
    }
}

/// Slack's own palette. Deliberately not the Honmaru tokens — this screen is a
/// quotation of another product.
private enum Slack {
    static let canvas = Color(hex: 0xFFFFFF)
    static let ink = Color(hex: 0x1D1C1D)
    static let muted = Color(hex: 0x616061)
    static let badge = Color(hex: 0xE01E5A)
    static let presence = Color(hex: 0x2BAC76)
}

private enum Fixtures {
    enum Lead {
        case hash
        case avatar(String, UInt, Bool)
    }

    struct Row: Identifiable {
        let id = UUID()
        let lead: Lead
        let name: String
        let preview: String
        let time: String
        let isUnread: Bool
        let badge: Int
    }

    static let channels: [Row] = [
        .init(lead: .hash, name: "release",
              preview: "Dana: I think we're ready to ship. Everything through PR214…",
              time: "6m", isUnread: true, badge: 1),
        .init(lead: .hash, name: "design",
              preview: "Carol: team is split between warm and monochrome for the…",
              time: "40m", isUnread: true, badge: 2),
        .init(lead: .hash, name: "general",
              preview: "Alex: standup notes posted",
              time: "1d", isUnread: false, badge: 0),
    ]

    static let directMessages: [Row] = [
        .init(lead: .avatar("B", 0xE8912D, true), name: "Bob",
              preview: "▶︎ Voice memo · 0:42", time: "22m", isUnread: true, badge: 1),
        .init(lead: .avatar("D", 0x7C3085, true), name: "Dana",
              preview: "thanks! shipping notes updated", time: "2h", isUnread: false, badge: 0),
        .init(lead: .avatar("C", 0x2BAC76, false), name: "Carol",
              preview: "see you at the crit", time: "3h", isUnread: false, badge: 0),
    ]

    static let apps: [Row] = [
        .init(lead: .avatar("G", 0x1D1C1D, false), name: "GitHub",
              preview: "Merged: fix(auth): cache token validation — deploy verified",
              time: "1h", isUnread: true, badge: 1),
        .init(lead: .avatar("N", 0x616061, false), name: "Notion",
              preview: "Q3 Planning: Without one more iOS hire the roadmap slips…",
              time: "2h", isUnread: true, badge: 1),
    ]
}

#Preview {
    ClassicListView()
}
