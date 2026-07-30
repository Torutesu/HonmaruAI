import Foundation
import UIKit
import UserNotifications

// Registers the device for APNs and forwards the token to the relay.
// The relay only pushes pending high/urgent decisions to offline users,
// so granting permission never opens a notification firehose.
@MainActor
final class PushNotificationService: NSObject, ObservableObject {
    static let openCardNotification = Notification.Name("openCardFromPush")

    @Published private(set) var deviceToken: String?

    private var backendBaseURL: URL?
    private var relayToken: String?
    private var currentUserID: String?
    private var didRequestAuthorization = false

    func configure(backendBaseURL: URL?, relayToken: String?) {
        self.backendBaseURL = backendBaseURL
        self.relayToken = relayToken
    }

    // Called on session activation and user switch — asks permission once,
    // then (re)binds this device's token to the active user on the relay.
    func activate(for userID: String) {
        currentUserID = userID
        UNUserNotificationCenter.current().delegate = self

        Task {
            if !didRequestAuthorization {
                didRequestAuthorization = true
                let granted = (try? await UNUserNotificationCenter.current()
                    .requestAuthorization(options: [.alert, .sound, .badge])) ?? false
                guard granted else { return }
                UIApplication.shared.registerForRemoteNotifications()
            }
            await registerWithRelay()
        }
    }

    func handleDeviceToken(_ data: Data) {
        deviceToken = data.map { String(format: "%02x", $0) }.joined()
        Task { await registerWithRelay() }
    }

    private func registerWithRelay() async {
        guard let deviceToken, let currentUserID, let backendBaseURL,
              let url = URL(string: "/push/register", relativeTo: backendBaseURL) else {
            return
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let relayToken, !relayToken.isEmpty {
            request.setValue("Bearer \(relayToken)", forHTTPHeaderField: "Authorization")
        }
        request.httpBody = try? JSONSerialization.data(withJSONObject: [
            "userId": currentUserID,
            "deviceToken": deviceToken,
        ])

        _ = try? await URLSession.shared.data(for: request)
    }
}

extension PushNotificationService: UNUserNotificationCenterDelegate {
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        [.banner, .sound]
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        let userInfo = response.notification.request.content.userInfo
        guard let cardID = userInfo["cardID"] as? String else { return }
        await MainActor.run {
            NotificationCenter.default.post(
                name: Self.openCardNotification,
                object: cardID
            )
        }
    }
}
