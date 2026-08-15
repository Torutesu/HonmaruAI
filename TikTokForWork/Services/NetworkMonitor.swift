import Foundation
import Network

/// Tells the app the moment a path comes back.
///
/// Backoff alone means a device that regains wifi after a tunnel still waits out
/// whatever delay it had reached — up to thirty seconds of staring at a feed
/// that could already be live. The path update collapses that to zero.
@MainActor
final class NetworkMonitor: ObservableObject {
    @Published private(set) var isOnline = true

    private let monitor = NWPathMonitor()
    private let queue = DispatchQueue(label: "com.honmaru.network")
    private var wasOffline = false

    /// Called when connectivity is regained, not on every path change — a
    /// wifi-to-cellular handover while online is not a reconnect trigger.
    var onBecameOnline: (() -> Void)?

    func start() {
        monitor.pathUpdateHandler = { [weak self] path in
            let online = path.status == .satisfied
            Task { @MainActor in
                guard let self else { return }
                self.isOnline = online
                if online, self.wasOffline {
                    self.onBecameOnline?()
                }
                self.wasOffline = !online
            }
        }
        monitor.start(queue: queue)
    }

    func stop() {
        monitor.cancel()
    }
}
