import SwiftUI

struct ChannelsView: View {
    @ObservedObject var channelService: ChannelService
    @Environment(\.dismiss) private var dismiss
    @State private var showNewChannel = false
    @State private var newChannelName = ""

    var body: some View {
        NavigationStack {
            Group {
                if channelService.channels.isEmpty {
                    VStack(spacing: Theme.Spacing.sm) {
                        Text("No channels yet")
                            .font(.system(size: 17, weight: .medium))
                            .foregroundStyle(Theme.Colors.textPrimary)
                        Text("Connect to the relay to sync channels")
                            .font(Theme.TypeScale.caption)
                            .foregroundStyle(Theme.Colors.textTertiary)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    ScrollView {
                        LazyVStack(spacing: 0) {
                            ForEach(channelService.channels) { channel in
                                NavigationLink(value: channel) {
                                    channelRow(channel)
                                }
                                .buttonStyle(.plain)
                            }
                        }
                        .padding(.vertical, Theme.Spacing.sm)
                    }
                }
            }
            .background(Theme.Colors.background)
            .navigationTitle("Channels")
            .navigationBarTitleDisplayMode(.inline)
            .navigationDestination(for: ChatChannel.self) { channel in
                ChannelTimelineView(channel: channel, channelService: channelService)
            }
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button {
                        showNewChannel = true
                    } label: {
                        Image(systemName: "plus")
                            .font(.system(size: 14, weight: .medium))
                            .foregroundStyle(Theme.Colors.textSecondary)
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                        .foregroundStyle(Theme.Colors.textSecondary)
                }
            }
            .alert("New channel", isPresented: $showNewChannel) {
                TextField("launch-plan", text: $newChannelName)
                    .textInputAutocapitalization(.never)
                Button("Create") {
                    let name = newChannelName
                    newChannelName = ""
                    Task { await channelService.createChannel(named: name) }
                }
                Button("Cancel", role: .cancel) { newChannelName = "" }
            } message: {
                Text("The AI files conversations into channels — create one only when a new stream of work starts.")
            }
        }
        .presentationBackground(Theme.Colors.surface)
        .presentationDragIndicator(.visible)
    }

    private func channelRow(_ channel: ChatChannel) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
            HStack(alignment: .firstTextBaseline) {
                Text("#\(channel.name)")
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(Theme.Colors.textPrimary)

                Spacer()

                if let last = channelService.lastMessage(in: channel.id) {
                    Text(DateFormatting.relative(last.createdAt))
                        .font(Theme.TypeScale.micro)
                        .foregroundStyle(Theme.Colors.textTertiary)
                }
            }

            if let last = channelService.lastMessage(in: channel.id) {
                HStack(spacing: 4) {
                    if last.isAgent {
                        Image(systemName: "sparkle")
                            .font(.system(size: 9))
                            .foregroundStyle(Theme.Colors.accent)
                    }
                    Text("\(last.authorName): \(last.text)")
                        .font(Theme.TypeScale.caption)
                        .foregroundStyle(Theme.Colors.textSecondary)
                        .lineLimit(1)
                }
            } else if !channel.purpose.isEmpty {
                Text(channel.purpose)
                    .font(Theme.TypeScale.caption)
                    .foregroundStyle(Theme.Colors.textTertiary)
                    .lineLimit(1)
            }
        }
        .padding(.horizontal, Theme.Spacing.screen)
        .padding(.vertical, Theme.Spacing.md)
        .contentShape(Rectangle())
    }
}

struct ChannelTimelineView: View {
    let channel: ChatChannel
    @ObservedObject var channelService: ChannelService
    @State private var draft = ""
    @FocusState private var isFocused: Bool

    private var messages: [ChatMessage] {
        channelService.messages(in: channel.id)
    }

    var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: Theme.Spacing.lg) {
                        if messages.isEmpty {
                            Text("No messages yet. Humans and AI agents share this space — mention @ai to bring the team AI in.")
                                .font(Theme.TypeScale.caption)
                                .foregroundStyle(Theme.Colors.textTertiary)
                                .frame(maxWidth: .infinity, alignment: .center)
                                .padding(.top, Theme.Spacing.xxl)
                        }

                        ForEach(messages) { message in
                            MessageRow(message: message)
                                .id(message.id)
                        }
                    }
                    .padding(.horizontal, Theme.Spacing.screen)
                    .padding(.vertical, Theme.Spacing.md)
                }
                .onAppear {
                    if let last = messages.last {
                        proxy.scrollTo(last.id, anchor: .bottom)
                    }
                }
                .onChange(of: messages.count) { _, _ in
                    guard let last = messages.last else { return }
                    withAnimation(.easeOut(duration: 0.15)) {
                        proxy.scrollTo(last.id, anchor: .bottom)
                    }
                }
            }

            composer
        }
        .background(Theme.Colors.background)
        .navigationTitle("#\(channel.name)")
        .navigationBarTitleDisplayMode(.inline)
    }

    private var composer: some View {
        VStack(spacing: Theme.Spacing.xs) {
            HStack(spacing: Theme.Spacing.sm) {
                TextField("Message #\(channel.name)", text: $draft, axis: .vertical)
                    .font(Theme.TypeScale.body)
                    .foregroundStyle(Theme.Colors.textPrimary)
                    .lineLimit(1...4)
                    .focused($isFocused)
                    .padding(Theme.Spacing.md)
                    .background(Theme.Colors.surfaceRaised)
                    .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))
                    .onSubmit(send)

                DictationButton(text: $draft)

                Button(action: send) {
                    Image(systemName: "arrow.up")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(
                            draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                                ? Theme.Colors.textTertiary
                                : Theme.Colors.accent
                        )
                        .frame(width: 36, height: 36)
                        .background(Theme.Colors.surfaceRaised)
                        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))
                }
                .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }

            Text("@ai joins the conversation · @ai file: <ask> routes a decision card")
                .font(Theme.TypeScale.micro)
                .foregroundStyle(Theme.Colors.textTertiary)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, Theme.Spacing.screen)
        .padding(.top, Theme.Spacing.sm)
        .padding(.bottom, Theme.Spacing.md)
        .background(Theme.Colors.background)
    }

    private func send() {
        let text = draft
        draft = ""
        Task { await channelService.send(text: text, in: channel.id) }
    }
}

private struct MessageRow: View {
    let message: ChatMessage

    var body: some View {
        HStack(alignment: .top, spacing: Theme.Spacing.md) {
            avatar

            VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
                HStack(alignment: .firstTextBaseline, spacing: Theme.Spacing.sm) {
                    Text(message.authorName)
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(
                            message.isAgent ? Theme.Colors.accent : Theme.Colors.textPrimary
                        )

                    if message.isAgent {
                        Text("AI")
                            .font(.system(size: 9, weight: .semibold))
                            .foregroundStyle(Theme.Colors.accent)
                            .padding(.horizontal, 4)
                            .padding(.vertical, 1)
                            .background(Theme.Colors.accent.opacity(0.12))
                            .clipShape(RoundedRectangle(cornerRadius: 2))
                    }

                    Text(DateFormatting.relative(message.createdAt))
                        .font(Theme.TypeScale.micro)
                        .foregroundStyle(Theme.Colors.textTertiary)
                }

                Text(message.text)
                    .font(Theme.TypeScale.body)
                    .foregroundStyle(Theme.Colors.textSecondary)
                    .lineSpacing(3)
                    .fixedSize(horizontal: false, vertical: true)

                if let toolCalls = message.toolCalls, !toolCalls.isEmpty {
                    VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
                        ForEach(toolCalls) { call in
                            ToolCallChip(call: call)
                        }
                    }
                    .padding(.top, Theme.Spacing.xs)
                }

                if message.cardID != nil {
                    Text("Decision card routed — it's in the recipient's feed")
                        .font(Theme.TypeScale.micro)
                        .foregroundStyle(Theme.Colors.textTertiary)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var avatar: some View {
        ZStack {
            RoundedRectangle(cornerRadius: Theme.Radius.sm)
                .fill(message.isAgent ? Theme.Colors.accent.opacity(0.15) : Theme.Colors.surfaceRaised)
                .frame(width: 28, height: 28)

            if message.isAgent {
                Image(systemName: "sparkle")
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.Colors.accent)
            } else {
                Text(String(message.authorName.prefix(1)))
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(Theme.Colors.textSecondary)
            }
        }
    }
}
