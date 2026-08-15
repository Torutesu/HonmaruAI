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

    /// Whether this build can actually receive a notification.
    ///
    /// False, and deliberately. Sending needs `aps-environment` in the
    /// entitlements, and that entitlement has to be in the provisioning profile
    /// — "HonmaruAI AppStore" was issued before push existed, so an archive
    /// carrying it fails to sign. Rather than block the release on Apple
    /// Developer portal work, this build ships the whole mechanism switched off.
    ///
    /// It is a constant rather than a runtime check because there is no public
    /// API to ask the running app which entitlements it was signed with, and
    /// guessing wrong in the permissive direction is the expensive mistake:
    /// **iOS grants exactly one notification prompt, ever.** Spending it in a
    /// build that cannot deliver anything is how you end up permanently unable
    /// to notify someone who would have said yes.
    ///
    /// Turning it on is four things, all of which must land together:
    ///   1. Enable Push Notifications on the App ID `com.honmaru.ai`, and
    ///      regenerate the "HonmaruAI AppStore" provisioning profile.
    ///   2. Restore `TikTokForWork/HonmaruAI.entitlements` with
    ///      `aps-environment` = `development`, and point `project.yml` at it
    ///      (it goes under the target's `entitlements:` key, and must also be
    ///      added to the sources `excludes`).
    ///   3. Set the four APNs Worker secrets — `docs/push-notifications.md`.
    ///   4. Flip this to `true`.
    static let isEnabledInThisBuild = false

    @Published private(set) var authorization: UNAuthorizationStatus = .notDetermined

    /// Set when a notification is tapped, so the feed can scroll to that card.
    @Published var pendingCardID: String?

    private var backendBaseURL: URL?
    private var deviceToken: String?
    private var didRequestThisLaunch = false

    func configure(backendBaseURL: URL?) {
        self.backendBaseURL = backendBaseURL
        // The delegate is set either way: a build without push still has to
        // present a local notification sensibly if one is ever posted, and
        // setting it costs nothing.
        UNUserNotificationCenter.current().delegate = self
        Task { await refreshAuthorization() }
    }

    func refreshAuthorization() async {
        authorization = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
        guard PushService.isEnabledInThisBuild else { return }
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
        // The one prompt iOS will ever give us is not spent by a build that
        // cannot deliver anything.
        guard PushService.isEnabledInThisBuild else { return }
        guard !didRequestThisLaunch else { return }
        guard authorization == .notDetermined else { return }
        didRequestThisLaunch = true

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
        guard PushService.isEnabledInThisBuild, let deviceToken else { return }
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
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound, .badge])
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let cardID = response.notification.request.content.userInfo["cardId"] as? String
        Task { @MainActor in
            PushService.shared.pendingCardID = cardID
        }
        // Answered immediately rather than inside the hop: the system wants to
        // know we handled the tap, not to wait for the feed to scroll.
        completionHandler()
    }
}
