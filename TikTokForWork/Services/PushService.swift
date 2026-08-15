import Foundation
import UIKit
import UserNotifications

/// Push notifications, and the one decision that matters about them: when to ask.
///
/// Asking at launch is the reflex, and it is why so many apps get a permanent
/// "Don't Allow" — the user has been given no reason yet. iOS grants exactly one
/// prompt, ever, so spending it on a cold first screen throws it away. This asks
/// after the first decision has been made, at the moment the value of "we will
/// tell you when the next one arrives" is obvious.
@MainActor
final class PushService: NSObject, ObservableObject {
    static let shared = PushService()

    @Published private(set) var authorization: UNAuthorizationStatus = .notDetermined

    /// Set when a notification is tapped, so the feed can scroll to that card.
    @Published var pendingCardID: String?

    private var backendBaseURL: URL?
    private var deviceToken: String?
    private var didRequestThisLaunch = false

    private let askedKey = "didAskForNotifications"

    func configure(backendBaseURL: URL?) {
        self.backendBaseURL = backendBaseURL
        UNUserNotificationCenter.current().delegate = self
        Task { await refreshAuthorization() }
    }

    func refreshAuthorization() async {
        authorization = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
        // Already granted on a previous launch: re-register without prompting.
        // APNs reissues tokens, and a stale one is a silent no-op — the user
        // simply stops being told anything and never finds out why.
        if authorization == .authorized {
            UIApplication.shared.registerForRemoteNotifications()
        }
    }

    /// Ask, if it is the right moment and we have not already. Safe to call from
    /// anywhere: everything that would make asking wrong is checked here rather
    /// than at each call site.
    func requestAuthorizationIfEarned() async {
        guard !didRequestThisLaunch else { return }
        guard authorization == .notDetermined else { return }
        didRequestThisLaunch = true
        UserDefaults.standard.set(true, forKey: askedKey)

        do {
            let granted = try await UNUserNotificationCenter.current()
                .requestAuthorization(options: [.alert, .sound, .badge])
            await refreshAuthorization()
            if granted { UIApplication.shared.registerForRemoteNotifications() }
        } catch {
            await refreshAuthorization()
        }
    }

    /// Called from the app delegate with the raw token Apple handed us.
    func register(deviceToken data: Data, sessionToken: String?) {
        let token = data.map { String(format: "%02x", $0) }.joined()
        deviceToken = token
        Task { await upload(token: token, sessionToken: sessionToken) }
    }

    /// Re-registered on every sign-in too: the token is bound to a person on the
    /// server, and a device that changes hands must stop receiving the previous
    /// account's decisions.
    func registerExistingToken(sessionToken: String?) {
        guard let deviceToken else { return }
        Task { await upload(token: deviceToken, sessionToken: sessionToken) }
    }

    func unregister(sessionToken: String?) async {
        guard let deviceToken, let request = makeRequest(method: "DELETE", token: deviceToken, sessionToken: sessionToken) else {
            return
        }
        _ = try? await URLSession.shared.data(for: request)
        self.deviceToken = nil
    }

    func setBadge(_ count: Int) {
        UNUserNotificationCenter.current().setBadgeCount(max(0, count))
    }

    private func upload(token: String, sessionToken: String?) async {
        guard let request = makeRequest(method: "POST", token: token, sessionToken: sessionToken) else { return }
        // A failure here means notifications quietly do not arrive, which is
        // annoying rather than broken — and the next launch re-registers.
        _ = try? await URLSession.shared.data(for: request)
    }

    private func makeRequest(method: String, token: String, sessionToken: String?) -> URLRequest? {
        guard let backendBaseURL, let sessionToken, !sessionToken.isEmpty else { return nil }
        var request = URLRequest(url: backendBaseURL.appending(path: "devices"))
        request.httpMethod = method
        request.timeoutInterval = 15
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(sessionToken, forHTTPHeaderField: "x-session-token")
        request.httpBody = try? JSONSerialization.data(withJSONObject: [
            "deviceToken": token,
            "environment": PushService.environment,
        ])
        return request
    }

    /// A TestFlight or App Store build talks to production APNs; a build from
    /// Xcode talks to the sandbox. Sending to the wrong one fails with
    /// BadDeviceToken, which looks exactly like a bug in the code.
    private static var environment: String {
        #if DEBUG
        return "sandbox"
        #else
        return "production"
        #endif
    }
}

extension PushService: UNUserNotificationCenterDelegate {
    /// Show the banner even in the foreground. The feed is a queue, not a
    /// conversation — a decision arriving while you are looking at another one
    /// is exactly what you want to know about.
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        [.banner, .sound, .badge]
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        let cardID = response.notification.request.content.userInfo["cardId"] as? String
        await MainActor.run {
            PushService.shared.pendingCardID = cardID
        }
    }
}
