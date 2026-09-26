import SwiftUI

/// Pause notifications for a while, and the hours they may come at all.
/// While paused or outside the hours, nothing reaches this phone, the
/// browser or the inbox; it all waits in Activity. The Worker decides, so
/// the phone and the laptop keep one rule.
struct QuietTimeView: View {
    @EnvironmentObject private var appState: AppState
    @State private var pausedUntil: Date?
    @State private var schedule = Schedule()
    @State private var loaded = false
    @State private var error: String?

    struct Schedule: Codable, Equatable {
        var enabled = false
        var days: [Int] = [1, 2, 3, 4, 5]
        var from = "09:00"
        var to = "18:00"
    }
    private struct Me: Decodable { let notifyPausedUntil: String?; let notifySchedule: Schedule? }

    var body: some View {
        Form {
            Section {
                if let pausedUntil, pausedUntil > .now {
                    Label { Text("Paused until \(pausedUntil.formatted(date: .abbreviated, time: .shortened))") } icon: { Image(systemName: "bell.slash.fill").foregroundStyle(.orange) }
                    Button("Resume now") { Task { await save(["pausedUntil": NSNull()]) } }
                } else {
                    Button("30 minutes") { Task { await save(["pauseMinutes": 30]) } }
                    Button("1 hour") { Task { await save(["pauseMinutes": 60]) } }
                    Button("2 hours") { Task { await save(["pauseMinutes": 120]) } }
                    Button("Until tomorrow 9:00") { Task { await save(["pausedUntil": ChatDates.string(ChatTimes.tomorrow(at: 9))]) } }
                }
            } header: { Text("Pause notifications") } footer: { Text("While paused, nothing reaches your phone, browser or inbox. It all waits in Activity.") }

            Section {
                Toggle("Only notify me during these hours", isOn: Binding(get: { schedule.enabled }, set: { v in schedule.enabled = v; Task { await saveSchedule() } }))
                if schedule.enabled {
                    HStack(spacing: 6) {
                        ForEach([1, 2, 3, 4, 5, 6, 0], id: \.self) { d in
                            let on = schedule.days.contains(d)
                            Button {
                                if on { schedule.days.removeAll { $0 == d } } else { schedule.days.append(d) }
                                Task { await saveSchedule() }
                            } label: {
                                Text(Calendar.current.veryShortWeekdaySymbols[d]).font(.subheadline.weight(.semibold))
                                    .frame(maxWidth: .infinity, minHeight: 34)
                                    .foregroundStyle(on ? Theme.Colors.background : Theme.Colors.textPrimary)
                                    .background(on ? Theme.Colors.textPrimary : Theme.Colors.surfaceRaised, in: Capsule())
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel(Text(Calendar.current.weekdaySymbols[d]))
                            .accessibilityAddTraits(on ? .isSelected : [])
                        }
                    }
                    DatePicker("From", selection: time(\.from), displayedComponents: .hourAndMinute)
                    DatePicker("To", selection: time(\.to), displayedComponents: .hourAndMinute)
                }
            } header: { Text("Notification hours") } footer: { Text("In your own time zone. Outside them it is quiet, as if paused.") }

            if let error { Section { Text(error).foregroundStyle(Theme.Colors.reject) } }
        }
        .navigationTitle("Pause and hours").navigationBarTitleDisplayMode(.inline)
        .disabled(!loaded)
        .task { await load() }
    }

    /// "HH:mm" as a Date today, for the pickers, and back.
    private func time(_ key: WritableKeyPath<Schedule, String>) -> Binding<Date> {
        Binding(get: {
            let parts = schedule[keyPath: key].split(separator: ":").compactMap { Int($0) }
            return Calendar.current.date(bySettingHour: parts.first ?? 9, minute: parts.last ?? 0, second: 0, of: .now) ?? .now
        }, set: { date in
            let c = Calendar.current.dateComponents([.hour, .minute], from: date)
            schedule[keyPath: key] = String(format: "%02d:%02d", c.hour ?? 0, c.minute ?? 0)
            Task { await saveSchedule() }
        })
    }

    private func load() async {
        guard let base = appState.backendBaseURL, let token = SessionStore.sessionToken else { return }
        var request = URLRequest(url: base.appending(path: "me"))
        request.setValue(token, forHTTPHeaderField: "x-session-token")
        if let fetched = try? await URLSession.shared.data(for: request), let me = try? JSONDecoder().decode(Me.self, from: fetched.0) {
            apply(me)
        }
        loaded = true
    }

    private func apply(_ me: Me) {
        pausedUntil = ChatDates.parse(me.notifyPausedUntil)
        if let s = me.notifySchedule { schedule = s }
    }

    private func saveSchedule() async {
        let body: [String: Any] = ["notifySchedule": ["enabled": schedule.enabled, "days": schedule.days, "from": schedule.from, "to": schedule.to]]
        await save(body)
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
            guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else { error = String(localized: "That did not save."); return }
            error = nil
            if let me = try? JSONDecoder().decode(Me.self, from: data) { apply(me) }
            Haptics.light()
        } catch { self.error = error.localizedDescription }
    }
}
