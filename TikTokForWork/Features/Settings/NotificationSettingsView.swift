import SwiftUI
import UIKit
import UserNotifications

/// Notifications on this iPhone: whether iOS lets them through, whether the
/// server knows to send them here, and what to do when something is in the
/// way; then how they are delivered (#236). The same choices as the web's
/// Notifications screen, read from and saved to the same account.
struct NotificationSettingsView: View {
    @EnvironmentObject private var appState: AppState
    @EnvironmentObject private var push: PushService
    @Environment(\.scenePhase) private var scenePhase
    @State private var me: Me?
    @State private var error: String?

    private struct Me: Decodable {
        var pushWhileActive: Bool?
        var notifyEmail: Bool?
    }

    private var allowed: Bool {
        push.authorization == .authorized || push.authorization == .provisional || push.authorization == .ephemeral
    }

    var body: some View {
        Form {
            Section {
                HStack {
                    Label("Notifications", systemImage: "bell")
                    Spacer(minLength: 8)
                    Text(statusText).foregroundStyle(statusColor)
                }
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("notificationStatus")
                if push.authorization == .notDetermined {
                    Button("Turn on notifications") { Task { await push.turnOn() } }
                        .accessibilityIdentifier("turnOnNotifications")
                } else if push.authorization == .denied {
                    Button("Open iOS Settings", action: openSettings)
                        .accessibilityIdentifier("openNotificationSettings")
                } else if allowed {
                    registrationRow
                    if push.bannersOff || push.inScheduledSummary || push.authorization == .provisional {
                        Button("Open iOS Settings", action: openSettings)
                            .accessibilityIdentifier("openNotificationSettings")
                    }
                }
            } header: {
                Text("On this iPhone")
            } footer: {
                Text(guidance)
            }

            if !appState.isGuest {
                Section {
                    Toggle("Push to my phone while I use a computer", isOn: Binding(
                        get: { me?.pushWhileActive ?? false },
                        set: { on in me?.pushWhileActive = on; Task { await save(["pushWhileActive": on]) } }))
                        .disabled(me == nil)
                } footer: {
                    Text("Off: while you are using HonmaruAI somewhere, your phone stays quiet, and a message you have not read reaches it after a minute.")
                }
                Section {
                    Toggle("Email as the fallback", isOn: Binding(
                        get: { me?.notifyEmail ?? true },
                        set: { on in me?.notifyEmail = on; Task { await save(["notifyEmail": on]) } }))
                        .disabled(me == nil)
                } footer: {
                    Text("Only when no device of yours can be reached. Never a duplicate.")
                }
                Section {
                    NavigationLink { QuietTimeView().environmentObject(appState) } label: {
                        Label("Pause and hours", systemImage: "bell.slash")
                    }
                }
            }
            if let error {
                Section { Text(error).foregroundStyle(Theme.Colors.reject) }
            }
        }
        .navigationTitle("Notifications")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            await push.refreshAuthorization()
            await load()
        }
        // Back from iOS Settings: what was changed there, shown here.
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await push.refreshAuthorization() } }
        }
    }

    private var statusText: String {
        switch push.authorization {
        case .notDetermined: return String(localized: "Not turned on yet")
        case .denied: return String(localized: "Off in iOS Settings")
        case .provisional: return String(localized: "Delivered quietly")
        default: return String(localized: "On")
        }
    }

    private var statusColor: Color {
        switch push.authorization {
        case .denied: return Theme.Colors.reject
        case .authorized, .ephemeral: return push.bannersOff || push.inScheduledSummary ? .orange : Theme.Colors.approve
        default: return Theme.Colors.textSecondary
        }
    }

    /// What is in the way, in the order it would matter, and what to do.
    private var guidance: String {
        switch push.authorization {
        case .notDetermined:
            return String(localized: "Turn them on to be told when a decision needs you, someone writes to you, or someone answers you.")
        case .denied:
            return String(localized: "Notifications for Honmaru AI are turned off in iOS Settings. Open Settings, tap Notifications, and turn on Allow Notifications.")
        case .provisional:
            return String(localized: "Notifications arrive quietly in Notification Center. To see them as they come, choose Immediate Delivery in iOS Settings.")
        default:
            if push.bannersOff {
                return String(localized: "Banners are off for Honmaru AI, so notifications go to Notification Center without showing. Turn banners on in iOS Settings.")
            }
            if push.inScheduledSummary {
                return String(localized: "Honmaru AI is in your Scheduled Summary, so notifications arrive later, in a batch. Take it out in iOS Settings to be told right away.")
            }
            return String(localized: "If a Focus is on, notifications can be held until it ends.")
        }
    }

    @ViewBuilder
    private var registrationRow: some View {
        switch push.registration {
        case .registered:
            Label("This iPhone is registered", systemImage: "checkmark.circle.fill")
                .foregroundStyle(Theme.Colors.approve)
                .accessibilityIdentifier("pushRegistered")
        case .registering:
            HStack(spacing: 8) {
                ProgressView()
                Text("Registering this iPhone…").foregroundStyle(Theme.Colors.textSecondary)
            }
        case .unregistered:
            Button("Register this iPhone") { Task { await push.turnOn() } }
        case .failed(let why):
            VStack(alignment: .leading, spacing: 6) {
                Text("This iPhone could not be registered for notifications. \(why)")
                    .font(.footnote).foregroundStyle(Theme.Colors.reject)
                Button("Try again") { Task { await push.turnOn() } }
            }
        }
    }

    private func openSettings() {
        // Straight to this app's notification settings.
        if let url = URL(string: UIApplication.openNotificationSettingsURLString) { UIApplication.shared.open(url) }
    }

    private func load() async {
        guard !appState.isGuest, let base = appState.backendBaseURL, let token = SessionStore.sessionToken else { return }
        var request = URLRequest(url: base.appending(path: "me"))
        request.setValue(token, forHTTPHeaderField: "x-session-token")
        if let fetched = try? await URLSession.shared.data(for: request), let decoded = try? JSONDecoder().decode(Me.self, from: fetched.0) {
            me = decoded
        } else {
            error = String(localized: "Could not read your settings.")
        }
    }

    private func save(_ body: [String: Any]) async {
        guard let base = appState.backendBaseURL, let token = SessionStore.sessionToken else { return }
        var request = URLRequest(url: base.appending(path: "me"))
        request.httpMethod = "PUT"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(token, forHTTPHeaderField: "x-session-token")
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
                error = String(localized: "That did not save.")
                await load()
                return
            }
            error = nil
            if let decoded = try? JSONDecoder().decode(Me.self, from: data) { me = decoded }
            Haptics.light()
        } catch {
            self.error = error.localizedDescription
            await load()
        }
    }
}
