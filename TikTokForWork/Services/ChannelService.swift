import Foundation

@MainActor
final class ChannelService: ObservableObject {
    @Published private(set) var channels: [ChatChannel] = []
    @Published private(set) var messagesByChannel: [String: [ChatMessage]] = [:]

    private weak var webSocketService: WebSocketService?

    func attach(webSocketService: WebSocketService) {
        self.webSocketService = webSocketService
        webSocketService.addEventHandler { [weak self] event in
            self?.handle(event)
        }
    }

    func messages(in channelID: String) -> [ChatMessage] {
        messagesByChannel[channelID, default: []]
    }

    func lastMessage(in channelID: String) -> ChatMessage? {
        messagesByChannel[channelID]?.last
    }

    func send(text: String, in channelID: String) async {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        await webSocketService?.sendChannelMessage(channelID: channelID, text: trimmed)
    }

    func createChannel(named name: String) async {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        await webSocketService?.createChannel(named: trimmed)
    }

    func reset() {
        channels = []
        messagesByChannel = [:]
    }

    private func handle(_ event: RealtimeEvent) {
        switch event {
        case .channelSnapshot(let channels, let messagesByChannel):
            self.channels = channels.values.sorted { $0.createdAt < $1.createdAt }
            self.messagesByChannel = messagesByChannel
        case .channelCreated(let channel):
            guard !channels.contains(where: { $0.id == channel.id }) else { return }
            channels.append(channel)
            channels.sort { $0.createdAt < $1.createdAt }
        case .channelMessage(let message):
            var list = messagesByChannel[message.channelID, default: []]
            guard !list.contains(where: { $0.id == message.id }) else { return }
            list.append(message)
            messagesByChannel[message.channelID] = list
        default:
            break
        }
    }
}
