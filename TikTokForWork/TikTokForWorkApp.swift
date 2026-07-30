import SwiftUI
import UIKit

final class AppDelegate: NSObject, UIApplicationDelegate {
    static weak var pushService: PushNotificationService?

    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        Task { @MainActor in
            AppDelegate.pushService?.handleDeviceToken(deviceToken)
        }
    }

    func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
        // No push entitlement (e.g. simulator without support) — the app
        // works fully without it.
    }
}

@main
struct TikTokForWorkApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var appState = AppState()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(appState)
                .onAppear {
                    AppDelegate.pushService = appState.pushService
                }
        }
    }
}
