import SwiftUI

/// When your AI drafts your daily report, and where it goes.
///
/// The morning plan and the evening report, each at the person's own time —
/// 08:00 and 22:00 where they live unless they say otherwise — each on or
/// off, on weekdays or every day, posted to the team's daily-report channel.
/// Offered once right after sign-in to someone who has none yet (the phone's
/// part of onboarding), and under You to change any of it later.
struct DailyReportSetupView: View {
    /// Right after sign-in: "Later" rather than "Cancel".
    var firstRun = false
    var onFinished: () -> Void = {}
    @EnvironmentObject private var appState: AppState
    @Environment(\.dismiss) private var dismiss

    @State private var loading = true
    @State private var channels: [DailyReportService.Channel] = []
    @State private var existing: [DailyReportService.Part: DailyReportService.Routine] = [:]
    @State private var morningOn = true
    @State private var eveningOn = true
    @State private var morning = DailyReportSetupView.time(8, 0)
    @State private var evening = DailyReportSetupView.time(22, 0)
    @State private var everyDay = false
    @State private var channel = ""
    @State private var newName = ""
    @State private var saving = false
    @State private var error: String?

    static let newChannel = "__new"

    private var orgId: String? {
        let id = appState.currentUser?.teamID ?? SessionStore.orgId
        return (id?.isEmpty ?? true) ? nil : id
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("Morning: today’s plan. Evening: how the day went. Your AI writes it in your own words from your day and tells you when it is ready; you check it and post it. Nothing goes out until you do.")
                        .font(.subheadline).foregroundStyle(Theme.Colors.textSecondary)
                }
                Section {
                    Toggle(isOn: $morningOn) {
                        VStack(alignment: .leading, spacing: 3) {
                            Text("Morning — today’s plan")
                            Text("What you will do today, where your tasks stand, where you need help.")
                                .font(.caption).foregroundStyle(Theme.Colors.textSecondary)
                        }
                    }
                    if morningOn {
                        DatePicker(String(localized: "Time"), selection: $morning, displayedComponents: .hourAndMinute)
                    }
                    Toggle(isOn: $eveningOn) {
                        VStack(alignment: .leading, spacing: 3) {
                            Text("Evening — how the day went")
                            Text("What you did, what went well, what to improve, tomorrow.")
                                .font(.caption).foregroundStyle(Theme.Colors.textSecondary)
                        }
                    }
                    if eveningOn {
                        DatePicker(String(localized: "Time"), selection: $evening, displayedComponents: .hourAndMinute)
                    }
                } footer: {
                    Text(String(localized: "Times are where you are (\(TimeZone.current.identifier)). You can change all of this later under You."))
                }
                Section {
                    Picker(String(localized: "When"), selection: $everyDay) {
                        Text("Every weekday").tag(false)
                        Text("Every day").tag(true)
                    }
                    Picker(String(localized: "Post to"), selection: $channel) {
                        ForEach(channels) { Text(verbatim: "#\($0.slug)").tag($0.key) }
                        Text("A new channel…").tag(Self.newChannel)
                    }
                    if channel == Self.newChannel {
                        TextField(String(localized: "New channel name"), text: $newName)
                            .textInputAutocapitalization(.never).autocorrectionDisabled()
                    }
                }
                if let error {
                    Section { Text(error).font(.footnote).foregroundStyle(Theme.Colors.reject) }
                }
            }
            .disabled(loading || saving)
            .overlay { if loading { ProgressView() } }
            .navigationTitle("Daily report")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(firstRun ? String(localized: "Later") : String(localized: "Cancel")) { finish() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(saving ? String(localized: "Saving…") : String(localized: "Save")) { save() }.disabled(!canSave)
                }
            }
            .task { await load() }
        }
        .interactiveDismissDisabled(saving)
    }

    private var canSave: Bool {
        guard !loading, !saving, !channel.isEmpty else { return false }
        if channel == Self.newChannel && (morningOn || eveningOn) {
            return !newName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
        return true
    }

    /// What the person already has: their two routines, and the team's
    /// channels — the daily-report one chosen if the team has it.
    @MainActor private func load() async {
        defer { loading = false }
        guard let base = appState.backendBaseURL, let orgId else { return }
        if newName.isEmpty { newName = String(localized: "daily-reports") }
        do {
            async let listed = DailyReportService.channels(orgId: orgId, backendBaseURL: base)
            async let mine = DailyReportService.routines(orgId: orgId, backendBaseURL: base)
            let (list, routines) = try await (listed, mine)
            channels = list
            for part in DailyReportService.Part.allCases {
                if let routine = routines.first(where: { $0.kind == part.rawValue }) { existing[part] = routine }
            }
            if let routine = existing[.morning] { morningOn = routine.enabled; morning = Self.time(routine.hour, routine.minute) }
            if let routine = existing[.evening] { eveningOn = routine.enabled; evening = Self.time(routine.hour, routine.minute) }
            let current = existing[.evening] ?? existing[.morning]
            everyDay = current?.cadence == "daily"
            if let key = current?.channel, key.hasPrefix("b:") {
                if !list.contains(where: { $0.key == key }) {
                    channels.append(DailyReportService.Channel(slug: String(key.dropFirst(2)), name: nil))
                }
                channel = key
            } else if let team = list.first(where: { DailyReportService.channelSlugs.contains($0.slug) }) {
                channel = team.key
            } else {
                channel = Self.newChannel
            }
        } catch {
            self.error = error.localizedDescription
            if channel.isEmpty { channel = Self.newChannel }
        }
    }

    /// Make the channel if it is new, then each half: changed if the person
    /// has it, made if they switched it on.
    private func save() {
        guard canSave, let base = appState.backendBaseURL, let orgId else { return }
        saving = true
        error = nil
        Task { @MainActor in
            do {
                var key = channel
                if key == Self.newChannel, morningOn || eveningOn {
                    let name = newName.trimmingCharacters(in: .whitespacesAndNewlines)
                    key = try await DailyReportService.makeChannel(named: name, orgId: orgId, backendBaseURL: base).key
                }
                let cadence = everyDay ? "daily" : "weekdays"
                for part in DailyReportService.Part.allCases {
                    let on = part == .morning ? morningOn : eveningOn
                    let time = Self.hourAndMinute(part == .morning ? morning : evening)
                    if let routine = existing[part] {
                        let target = key == Self.newChannel ? (routine.channel ?? "") : key
                        existing[part] = try await DailyReportService.update(
                            routine.id, hour: time.hour, minute: time.minute, cadence: cadence, channel: target,
                            enabled: on, orgId: orgId, backendBaseURL: base
                        )
                    } else if on {
                        existing[part] = try await DailyReportService.create(
                            part, hour: time.hour, minute: time.minute, cadence: cadence, channel: key,
                            orgId: orgId, backendBaseURL: base
                        )
                    }
                }
                Haptics.success()
                finish()
            } catch {
                self.error = error.localizedDescription
            }
            saving = false
        }
    }

    private func finish() {
        onFinished()
        dismiss()
    }

    static func time(_ hour: Int, _ minute: Int) -> Date {
        Calendar.current.date(bySettingHour: hour, minute: minute, second: 0, of: Date()) ?? Date()
    }

    static func hourAndMinute(_ date: Date) -> (hour: Int, minute: Int) {
        let parts = Calendar.current.dateComponents([.hour, .minute], from: date)
        return (parts.hour ?? 0, parts.minute ?? 0)
    }
}
