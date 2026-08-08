import SwiftUI

/// A4 — the Classic surface: a deliberate Slack iOS clone standing in for the
/// old way of working, so the difference from the Cards surface is visible side
/// by side.
///
/// It intentionally uses Slack's palette rather than ours. Layout follows
/// `docs/figma/classic-slack-rebuild.js`, which is the design of record. Inter
/// is substituted by the system face, as `docs/design-system.md` allows.
///
/// The rows are real: every one opens a conversation you can read and post to,
/// and decisions taken on a card appear here as messages.
struct ClassicListView: View {
    @EnvironmentObject private var appState: AppState

    @State private var openChannel: ChatChannel?

    let onAction: (DecisionCard, CardActionKind) -> Void

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                workspaceHeader
                searchPill

                section("Channels", channels: appState.chatStore.channels(of: .channel))
                section("Direct messages", channels: appState.chatStore.channels(of: .directMessage))
                section("Apps", channels: appState.chatStore.channels(of: .app))
            }
            .padding(.bottom, Theme.Spacing.sm)
        }
        .background(Slack.canvas)
        .onAppear(perform: mirrorPendingCards)
        .sheet(item: $openChannel) { channel in
            ClassicChannelView(
                channel: channel,
                pendingCards: channel.id == ChatStore.decisionsChannelID ? pendingCards : [],
                onDecide: onAction
            )
            .environmentObject(appState)
        }
    }

    private var pendingCards: [DecisionCard] {
        guard let user = appState.currentUser else { return [] }
        return appState.cardService.cards(for: user.id).filter(\.isPending)
    }

    /// Every waiting decision shows up in #decisions as an unread, which is the
    /// claim this screen makes: the same work, buried in a list.
    private func mirrorPendingCards() {
        for card in pendingCards {
            appState.chatStore.announce(card)
        }
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

    private func section(_ label: String, channels: [ChatChannel]) -> some View {
        Group {
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

            ForEach(channels) { row($0) }
        }
    }

    // MARK: - Rows

    private func row(_ channel: ChatChannel) -> some View {
        let unread = appState.chatStore.unreadCount(in: channel.id)
        let last = appState.chatStore.lastMessage(in: channel.id)

        return Button {
            openChannel = channel
        } label: {
            HStack(spacing: 10) {
                if let tint = channel.tint {
                    avatar(String(channel.name.prefix(1)), color: tint, online: channel.isOnline)
                } else {
                    Text("#")
                        .font(.system(size: 16))
                        .foregroundStyle(Slack.muted)
                        .frame(width: 28, height: 28)
                }

                VStack(alignment: .leading, spacing: 1) {
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text(channel.name)
                            .font(.system(size: 14.5, weight: unread > 0 ? .heavy : .regular))
                            .foregroundStyle(Slack.ink)
                        Spacer()
                        if let last {
                            Text(DateFormatting.relative(last.sentAt))
                                .font(.system(size: 10.5))
                                .foregroundStyle(Slack.muted)
                        }
                    }
                    Text(preview(last))
                        .font(.system(size: 12, weight: unread > 0 ? .medium : .regular))
                        .foregroundStyle(unread > 0 ? Slack.ink : Slack.muted)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }

                if unread > 0 {
                    Text("\(unread)")
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

    private func preview(_ message: ChatMessage?) -> String {
        guard let message else { return String(localized: "No messages yet") }
        // Cards carry a title and a summary on separate lines; a row has space
        // for the title only.
        let firstLine = message.body.split(separator: "\n").first.map(String.init) ?? message.body
        return "\(message.authorName): \(firstLine)"
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

#Preview {
    ClassicListView { _, _ in }
        .environmentObject(AppState())
}
