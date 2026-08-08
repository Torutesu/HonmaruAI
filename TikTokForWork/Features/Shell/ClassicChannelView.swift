import SwiftUI

/// Inside a channel: the conversation, and a composer that actually posts.
///
/// Decisions taken on a card show up here as messages, which is the point —
/// the two surfaces are two views of the same work, not two apps.
struct ClassicChannelView: View {
    let channel: ChatChannel
    /// Cards still waiting, so a decision can be finished from this side too.
    let pendingCards: [DecisionCard]
    let onDecide: (DecisionCard, CardActionKind) -> Void

    @EnvironmentObject private var appState: AppState
    @Environment(\.dismiss) private var dismiss
    @State private var composed = ""
    @FocusState private var composerFocused: Bool

    var body: some View {
        NavigationStack {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 14) {
                        ForEach(appState.chatStore.messages(in: channel.id)) { message in
                            messageRow(message)
                                .id(message.id)
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 12)
                }
                .onAppear {
                    appState.chatStore.markRead(channel.id)
                    scrollToEnd(proxy)
                }
                .onChange(of: appState.chatStore.messages(in: channel.id).count) { _, _ in
                    scrollToEnd(proxy)
                }
            }
            .background(Slack.canvas)
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("閉じる") { dismiss() }
                }
            }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                VStack(spacing: 0) {
                    if !pendingCards.isEmpty { decisionStrip }
                    composer
                }
            }
        }
    }

    private var title: String {
        switch channel.kind {
        case .channel: "#\(channel.name)"
        default: channel.name
        }
    }

    private func scrollToEnd(_ proxy: ScrollViewProxy) {
        guard let last = appState.chatStore.messages(in: channel.id).last else { return }
        withAnimation(.easeOut(duration: 0.2)) {
            proxy.scrollTo(last.id, anchor: .bottom)
        }
    }

    private func messageRow(_ message: ChatMessage) -> some View {
        HStack(alignment: .top, spacing: 10) {
            RoundedRectangle(cornerRadius: 6)
                .fill(message.isApp ? Theme.Colors.accent : Slack.ink)
                .frame(width: 32, height: 32)
                .overlay {
                    Text(String(message.authorName.prefix(1)))
                        .font(.system(size: 14, weight: .bold))
                        .foregroundStyle(.white)
                }

            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(message.authorName)
                        .font(.system(size: 15, weight: .bold))
                        .foregroundStyle(Slack.ink)
                    if message.isApp {
                        Text("APP")
                            .font(.system(size: 9, weight: .bold))
                            .foregroundStyle(Slack.muted)
                            .padding(.horizontal, 4)
                            .padding(.vertical, 1)
                            .background(Color(hex: 0xF2F2F2))
                            .clipShape(RoundedRectangle(cornerRadius: 3))
                    }
                    Text(DateFormatting.relative(message.sentAt))
                        .font(.system(size: 11))
                        .foregroundStyle(Slack.muted)
                }

                Text(message.body)
                    .font(.system(size: 15))
                    .foregroundStyle(Slack.ink)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    /// The decisions this channel is still waiting on, actionable in place.
    private var decisionStrip: some View {
        VStack(spacing: 8) {
            ForEach(pendingCards) { card in
                HStack(spacing: 8) {
                    VStack(alignment: .leading, spacing: 1) {
                        Text(card.title)
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(Slack.ink)
                            .lineLimit(1)
                        Text(card.senderName)
                            .font(.system(size: 11))
                            .foregroundStyle(Slack.muted)
                    }
                    Spacer(minLength: 8)

                    Button("却下") { onDecide(card, .reject) }
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(Slack.ink)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 6)
                        .overlay {
                            RoundedRectangle(cornerRadius: 4)
                                .strokeBorder(Color(hex: 0xDDDDDD), lineWidth: 1)
                        }

                    Button("承認") { onDecide(card, .createIssue) }
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 6)
                        .background(Slack.confirm)
                        .clipShape(RoundedRectangle(cornerRadius: 4))
                }
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(Color(hex: 0xF8F8F8))
        .overlay(alignment: .top) {
            Rectangle().fill(Color(hex: 0xE8E8E8)).frame(height: 1)
        }
    }

    private var composer: some View {
        HStack(spacing: 8) {
            TextField("#\(channel.name) にメッセージを送る", text: $composed, axis: .vertical)
                .font(.system(size: 15))
                .lineLimit(1...4)
                .focused($composerFocused)
                .padding(.horizontal, 12)
                .padding(.vertical, 9)
                .overlay {
                    RoundedRectangle(cornerRadius: 8)
                        .strokeBorder(Color(hex: 0xDDDDDD), lineWidth: 1)
                }

            Button {
                appState.chatStore.send(
                    composed,
                    to: channel.id,
                    author: appState.currentUser?.name ?? "You"
                )
                composed = ""
            } label: {
                Image(systemName: "paperplane.fill")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(width: 36, height: 36)
                    .background(canSend ? Slack.confirm : Color(hex: 0xCCCCCC))
                    .clipShape(RoundedRectangle(cornerRadius: 8))
            }
            .disabled(!canSend)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(Slack.canvas)
        .overlay(alignment: .top) {
            Rectangle().fill(Color(hex: 0xE8E8E8)).frame(height: 1)
        }
    }

    private var canSend: Bool {
        !composed.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
}
