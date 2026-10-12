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

    /// Enabled alongside the APNs entitlement in project.yml. Debug uses
    /// development APNs; Release uses the production distribution profile.
    static let isEnabledInThisBuild = true

    @Published private(set) var authorization: UNAuthorizationStatus = .notDetermined

    /// Whether this iPhone is known to the server as somewhere to send
    /// notifications. Allowed but never registered is the quiet failure:
    /// nothing arrives and nothing says why (#236).
    enum Registration: Equatable { case unregistered, registering, registered, failed(String) }
    @Published private(set) var registration: Registration = .unregistered

    /// How iOS shows what arrives, when it is allowed: banners off means a
    /// notification goes to Notification Center without a sound or a look;
    /// in the Scheduled Summary it arrives later, in a batch.
    @Published private(set) var bannersOff = false
    @Published private(set) var inScheduledSummary = false

    /// Set when a notification is tapped, so the feed can scroll to that card.
    @Published var pendingCardID: String?

    private var backendBaseURL: URL?
    /// This iPhone's APNs token. It belongs to the phone, not to whoever is
    /// signed in, so signing out keeps it: forgetting it meant signing in
    /// again registered nothing until the next time the app came forward.
    private var deviceToken: String?
    private var didRequestThisLaunch = false
    /// Registrations and removals, one after another. A sign-out's DELETE
    /// that reached the server after the next sign-in's POST removed the
    /// phone it had just registered — the same token, the same account.
    private var serverWork: Task<Void, Never>?

    func configure(backendBaseURL: URL?) {
        self.backendBaseURL = backendBaseURL
        // The delegate is set either way: a build without push still has to
        // present a local notification sensibly if one is ever posted, and
        // setting it costs nothing.
        UNUserNotificationCenter.current().delegate = self
        Task { await refreshAuthorization() }
    }

    func refreshAuthorization() async {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        authorization = settings.authorizationStatus
        bannersOff = settings.alertSetting == .disabled
        inScheduledSummary = settings.scheduledDeliverySetting == .enabled
        guard PushService.isEnabledInThisBuild else { return }
        // Already granted on a previous launch: re-register without prompting.
        // APNs reissues tokens, and a stale one is a silent no-op — the user
        // simply stops being told anything and never finds out why.
        if authorization == .authorized || authorization == .provisional || authorization == .ephemeral {
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

    /// Turned on from Notifications in You: asked when iOS has not been
    /// asked yet (the person chose to, so no moment is waited for), and
    /// otherwise registered again — a stale or failed registration is the
    /// other reason nothing arrives.
    func turnOn() async {
        guard PushService.isEnabledInThisBuild else { return }
        if authorization == .notDetermined {
            didRequestThisLaunch = true
            let granted = (try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])) ?? false
            await refreshAuthorization()
            if granted { registration = .registering; UIApplication.shared.registerForRemoteNotifications() }
        } else if authorization == .authorized || authorization == .provisional || authorization == .ephemeral {
            registration = .registering
            UIApplication.shared.registerForRemoteNotifications()
        }
    }

    /// Called from the app delegate with the raw token Apple handed us.
    func register(deviceToken data: Data, sessionToken: String?) {
        let token = data.map { String(format: "%02x", $0) }.joined()
        deviceToken = token
        inOrder { await self.upload(token: token, sessionToken: sessionToken) }
    }

    /// After whatever this service already asked the server to do.
    private func inOrder(_ work: @escaping @MainActor () async -> Void) {
        let before = serverWork
        serverWork = Task { @MainActor in
            await before?.value
            await work()
        }
    }

    /// Apple would not give this iPhone a token: said in Notifications,
    /// rather than only in a log nobody reads.
    func registrationFailed(_ error: Error) {
        registration = .failed(error.localizedDescription)
    }

    /// Re-registered on every sign-in too: the token is bound to a person on the
    /// server, and a device that changes hands must stop receiving the previous
    /// account's decisions.
    func registerExistingToken(sessionToken: String?) {
        guard PushService.isEnabledInThisBuild else { return }
        guard let deviceToken else {
            // No token yet this launch: ask Apple, and register() uploads it.
            Task { await refreshAuthorization() }
            return
        }
        inOrder { await self.upload(token: deviceToken, sessionToken: sessionToken) }
    }

    func unregister(sessionToken: String?) async {
        guard let deviceToken, let request = makeRequest(method: "DELETE", token: deviceToken, sessionToken: sessionToken) else {
            return
        }
        inOrder {
            _ = try? await URLSession.shared.data(for: request)
            self.registration = .unregistered
        }
        await serverWork?.value
    }

    /// Read somewhere — on this phone or another device — so what this phone
    /// still shows for it comes down: a conversation's notifications (not
    /// its threads'), or one thread's.
    /// Notifications for these messages, taken down: they were looked at in
    /// Activity, here or on another device.
    nonisolated static func clearDelivered(messageIds: [String]) {
        let wanted = Set(messageIds)
        guard !wanted.isEmpty else { return }
        let center = UNUserNotificationCenter.current()
        center.getDeliveredNotifications { list in
            let ids = list.filter { n in
                let info = n.request.content.userInfo
                return info["kind"] as? String == "message" && wanted.contains(info["messageId"] as? String ?? "")
            }.map(\.request.identifier)
            if !ids.isEmpty { center.removeDeliveredNotifications(withIdentifiers: ids) }
        }
    }

    /// A conversation read elsewhere: its notifications, in that workspace
    /// only — two teams' #general are different conversations.
    ///
    /// `readUpTo`, when the read came from elsewhere: only what was said up to
    /// it. A "read" push can arrive late — Apple delays background pushes —
    /// and taking down everything in the conversation then took down
    /// messages newer than the read, which looked like they never arrived.
    nonisolated static func clearDelivered(channel: String, parentId: String?, orgId: String? = nil, readUpTo: Date? = nil) {
        let center = UNUserNotificationCenter.current()
        center.getDeliveredNotifications { list in
            let ids = list.filter { n in
                let info = n.request.content.userInfo
                guard info["kind"] as? String == "message", (info["channel"] as? String) == channel else { return false }
                if let orgId, let theirs = info["orgId"] as? String, theirs != orgId { return false }
                if let readUpTo {
                    let said = (info["at"] as? String).flatMap(PushService.parseDate) ?? n.date
                    if said > readUpTo { return false }
                }
                let reply = info["parentId"] as? String
                return parentId == nil ? (reply == nil || reply?.isEmpty == true) : reply == parentId
            }.map(\.request.identifier)
            if !ids.isEmpty { center.removeDeliveredNotifications(withIdentifiers: ids) }
        }
    }

    nonisolated static func parseDate(_ text: String) -> Date? {
        let withFraction = ISO8601DateFormatter()
        withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return withFraction.date(from: text) ?? ISO8601DateFormatter().date(from: text)
    }

    func setBadge(_ count: Int) {
        UNUserNotificationCenter.current().setBadgeCount(max(0, count))
    }

    private func upload(token: String, sessionToken: String?) async {
        // Signed out: registered on the next sign-in (registerExistingToken).
        guard let request = makeRequest(method: "POST", token: token, sessionToken: sessionToken) else { return }
        registration = .registering
        // A failure here means notifications quietly do not arrive. The next
        // launch re-registers, and Notifications says so meanwhile.
        do {
            let (_, response) = try await URLSession.shared.data(for: request)
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            registration = (200...299).contains(status)
                ? .registered
                : .failed(String(localized: "The server answered \(status)."))
        } catch {
            registration = .failed(error.localizedDescription)
        }
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
        // .list too: shown in the foreground, it is still kept in
        // Notification Center for later, as one that arrived in the
        // background would be.
        completionHandler([.banner, .list, .sound, .badge])
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
