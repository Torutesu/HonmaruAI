import SwiftUI

// Classic Slack-style mode: channels + DMs, on the same realtime pipeline
// as the decision feed.

@MainActor
struct ChatTab: View {
    @EnvironmentObject private var appState: AppState

    var body: some View {
        ChatListView(
            cardService: appState.cardService,
            webSocketService: appState.webSocketService
        )
    }
}

@MainActor
struct ChatListView: View {
    @ObservedObject var cardService: DecisionCardService
    @ObservedObject var webSocketService: WebSocketService
    @EnvironmentObject private var appState: AppState

    @State private var selectedChannel: ChatChannel?
    @State private var newChannelName = ""
    @State private var errorMessage: String?

    private var selfID: String { appState.currentUser?.id ?? "" }

    var body: some View {
        NavigationStack {
            List {
                Section("Channels") {
                    ForEach(cardService.channels.filter { !$0.isDM }) { channel in
                        channelRow(channel)
                    }
                    HStack {
                        TextField("+ new channel", text: $newChannelName)
                            .font(Theme.TypeScale.caption)
                            .onSubmit { createChannel() }
                    }
                }

                Section("Direct messages") {
                    ForEach(OrgDirectory.shared.members.filter { $0.id != selfID }) { member in
                        dmRow(member)
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(Theme.Colors.background)
            .navigationTitle("Chat")
            .navigationBarTitleDisplayMode(.inline)
            .navigationDestination(item: $selectedChannel) { channel in
                ChatChannelView(
                    channel: channel,
                    cardService: cardService
                )
            }
            .alert("Error", isPresented: errorBinding) {
                Button("OK", role: .cancel) { errorMessage = nil }
            } message: {
                Text(errorMessage ?? "")
            }
        }
    }

    private var errorBinding: Binding<Bool> {
        Binding(
            get: { errorMessage != nil },
            set: { if !$0 { errorMessage = nil } }
        )
    }

    private func channelRow(_ channel: ChatChannel) -> some View {
        Button {
            selectedChannel = channel
        } label: {
            HStack {
                Text("#\(channel.name)")
                    .font(Theme.TypeScale.body)
                    .foregroundStyle(Theme.Colors.textPrimary)
                Spacer()
                unseenBadge(channel.id)
            }
        }
    }

    private func dmRow(_ member: User) -> some View {
        let dm = cardService.channels.first {
            $0.isDM && $0.memberUserIds.contains(member.id)
        }
        return Button {
            openDM(with: member)
        } label: {
            HStack(spacing: 8) {
                Circle()
                    .fill(
                        webSocketService.onlineUserIDs.contains(member.id)
                            ? Theme.Colors.approve
                            : Theme.Colors.surfaceRaised
                    )
                    .frame(width: 7, height: 7)
                VStack(alignment: .leading, spacing: 1) {
                    Text(member.name)
                        .font(Theme.TypeScale.body)
                        .foregroundStyle(Theme.Colors.textPrimary)
                    Text(member.role)
                        .font(Theme.TypeScale.micro)
                        .foregroundStyle(Theme.Colors.textTertiary)
                }
                Spacer()
                if let dm { unseenBadge(dm.id) }
            }
        }
    }

    @ViewBuilder
    private func unseenBadge(_ channelID: String) -> some View {
        let unseen = cardService.chatUnseenByChannel[channelID] ?? 0
        if unseen > 0 {
            Text("\(unseen)")
                .font(.system(size: 11, weight: .bold))
                .foregroundStyle(.white)
                .padding(.horizontal, 7)
                .padding(.vertical, 2)
                .background(Theme.Colors.accent)
                .clipShape(Capsule())
        }
    }

    private func createChannel() {
        let name = newChannelName.trimmingCharacters(in: .whitespaces)
        guard !name.isEmpty,
              let api = appState.api,
              let token = SessionStore.sessionToken,
              let orgID = SessionStore.orgID else { return }
        newChannelName = ""
        Task {
            do {
                let channel = try await api.createChannel(token: token, orgID: orgID, name: name)
                cardService.upsertChannel(channel)
                selectedChannel = channel
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }

    private func openDM(with member: User) {
        guard let api = appState.api,
              let token = SessionStore.sessionToken,
              let orgID = SessionStore.orgID else { return }
        Task {
            do {
                let channel = try await api.openDm(token: token, orgID: orgID, userID: member.id)
                cardService.upsertChannel(channel)
                selectedChannel = channel
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }
}

@MainActor
struct ChatChannelView: View {
    let channel: ChatChannel
    @ObservedObject var cardService: DecisionCardService
    @EnvironmentObject private var appState: AppState

    @State private var text = ""
    @State private var replyTo: ChatMessage?
    @State private var digestQueued = false

    private var selfID: String { appState.currentUser?.id ?? "" }

    private var messages: [ChatMessage] {
        cardService.chatMessagesByChannel[channel.id] ?? []
    }

    // Top-level messages, each followed by its indented thread replies.
    private var timeline: [(message: ChatMessage, isReply: Bool)] {
        var out: [(ChatMessage, Bool)] = []
        for message in messages where message.parentMessageId == nil {
            out.append((message, false))
            for reply in messages where reply.parentMessageId == message.id {
                out.append((reply, true))
            }
        }
        return out
    }

    var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: Theme.Spacing.md) {
                        if timeline.isEmpty {
                            Text("No messages yet. @name mentions notify; DMs always notify.")
                                .font(Theme.TypeScale.caption)
                                .foregroundStyle(Theme.Colors.textTertiary)
                                .frame(maxWidth: .infinity)
                                .padding(.top, Theme.Spacing.xl)
                        }
                        ForEach(timeline, id: \.message.id) { entry in
                            messageRow(entry.message, isReply: entry.isReply)
                                .id(entry.message.id)
                        }
                    }
                    .padding(Theme.Spacing.screen)
                }
                .onChange(of: messages.count) {
                    if let last = timeline.last?.message.id {
                        withAnimation { proxy.scrollTo(last, anchor: .bottom) }
                    }
                }
            }

            composer
        }
        .background(Theme.Colors.background)
        .navigationTitle(channel.displayName(selfID: selfID))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    queueDigest()
                } label: {
                    Image(systemName: "sparkles")
                        .foregroundStyle(Theme.Colors.accent)
                }
                .accessibilityLabel("AI digest of this conversation")
            }
        }
        .alert("Digest queued", isPresented: $digestQueued) {
            Button("OK", role: .cancel) {}
        } message: {
            Text("Your AI is reading the conversation — the digest card will land on your feed.")
        }
        .onAppear {
            cardService.openChatChannel(channel.id)
            loadHistory()
        }
        .onDisappear {
            if cardService.activeChatChannelID == channel.id {
                cardService.activeChatChannelID = nil
            }
        }
    }

    private func messageRow(_ message: ChatMessage, isReply: Bool) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                Text(message.authorName)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Theme.Colors.textPrimary)
                Text(DateFormatting.relative(message.createdAt))
                    .font(Theme.TypeScale.micro)
                    .foregroundStyle(Theme.Colors.textTertiary)
            }
            mentionText(message.text)
                .font(Theme.TypeScale.body)
                .foregroundStyle(Theme.Colors.textSecondary)
        }
        .padding(.leading, isReply ? Theme.Spacing.xl : 0)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
        .contextMenu {
            if !isReply {
                Button {
                    replyTo = message
                } label: {
                    Label("Reply in thread", systemImage: "arrowshape.turn.up.left")
                }
            }
        }
    }

    private var composer: some View {
        VStack(spacing: Theme.Spacing.sm) {
            if let replyTo {
                HStack {
                    Text("↳ replying to \(replyTo.authorName)")
                        .font(Theme.TypeScale.micro)
                        .foregroundStyle(Theme.Colors.accent)
                    Spacer()
                    Button("✕") { self.replyTo = nil }
                        .font(Theme.TypeScale.micro)
                        .foregroundStyle(Theme.Colors.textTertiary)
                }
            }
            HStack(spacing: Theme.Spacing.sm) {
                TextField("Message… (@name to mention)", text: $text)
                    .font(Theme.TypeScale.body)
                    .foregroundStyle(Theme.Colors.textPrimary)
                    .padding(Theme.Spacing.md)
                    .background(Theme.Colors.surfaceRaised)
                    .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))
                    .onSubmit { send() }
                Button {
                    send()
                } label: {
                    Image(systemName: "arrow.up")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(.white)
                        .frame(width: 40, height: 40)
                        .background(Theme.Colors.accent)
                        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))
                }
            }
        }
        .padding(.horizontal, Theme.Spacing.screen)
        .padding(.vertical, Theme.Spacing.sm)
        .background(Theme.Colors.surface)
    }

    private func mentionText(_ raw: String) -> Text {
        var result = Text(verbatim: "")
        for (index, token) in raw.split(separator: " ", omittingEmptySubsequences: false).enumerated() {
            let piece = String(token)
            let space = index == 0 ? Text(verbatim: "") : Text(verbatim: " ")
            if piece.hasPrefix("@"), piece.count > 1 {
                result = result + space + Text(piece).bold().foregroundColor(Theme.Colors.accent)
            } else {
                result = result + space + Text(piece)
            }
        }
        return result
    }

    private func send() {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        text = ""
        let parentID = replyTo?.id
        replyTo = nil
        Task {
            try? await cardService.sendChatMessage(
                channelID: channel.id,
                text: trimmed,
                parentMessageID: parentID
            )
            Haptics.light()
        }
    }

    private func loadHistory() {
        guard let api = appState.api, let token = SessionStore.sessionToken else { return }
        Task {
            if let history = try? await api.listChatMessages(token: token, channelID: channel.id) {
                cardService.seedChatMessages(channelID: channel.id, messages: history)
            }
        }
    }

    private func queueDigest() {
        guard let api = appState.api, let token = SessionStore.sessionToken else { return }
        Task {
            try? await api.summarizeChannel(token: token, channelID: channel.id)
            digestQueued = true
        }
    }
}
