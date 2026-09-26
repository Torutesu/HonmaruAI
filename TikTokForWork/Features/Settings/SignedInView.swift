import SwiftUI

/// Where you are signed in: this phone, a laptop, a browser at the office —
/// and signing any of them out, or every other one at once. A lost phone
/// is one tap from being nobody's way in.
struct SignedInView: View {
    @EnvironmentObject private var appState: AppState
    @State private var sessions: [SignedInSession] = []
    @State private var loaded = false
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        List {
            Section {
                if !loaded { ProgressView() }
                ForEach(sessions) { s in
                    HStack(spacing: 12) {
                        Image(systemName: s.client == "ios" ? "iphone" : "laptopcomputer")
                            .foregroundStyle(Theme.Colors.textSecondary).frame(width: 26)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(name(s)).font(.body.weight(.semibold))
                            Text(detail(s)).font(.caption).foregroundStyle(Theme.Colors.textSecondary)
                        }
                        Spacer()
                        if s.current {
                            Text("This device").font(.caption.weight(.semibold)).foregroundStyle(Theme.Colors.accent)
                        }
                    }
                    .swipeActions {
                        if !s.current {
                            Button(role: .destructive) { Task { await end(s.ref) } } label: { Label("Sign out", systemImage: "rectangle.portrait.and.arrow.right") }
                        }
                    }
                }
            } footer: { Text("Swipe a device to sign it out.") }

            if sessions.filter({ !$0.current }).count > 0 {
                Section {
                    Button(role: .destructive) { Task { await end(nil) } } label: { Text("Sign out everywhere else") }
                        .disabled(busy)
                }
            }
            if let error { Section { Text(error).foregroundStyle(Theme.Colors.reject) } }
        }
        .navigationTitle("Where you’re signed in").navigationBarTitleDisplayMode(.inline)
        .refreshable { await load() }
        .task { await load() }
    }

    private func name(_ s: SignedInSession) -> String {
        if let app = s.app { return app == "ipad" ? String(localized: "iPad app") : String(localized: "iPhone app") }
        if let browser = s.browser, let os = s.os { return String(localized: "\(browser) on \(os)") }
        return s.browser ?? s.os ?? String(localized: "Unknown device")
    }

    private func detail(_ s: SignedInSession) -> String {
        let when = ChatDates.parse(s.lastSeenAt).map { $0.formatted(.relative(presentation: .named)) } ?? ""
        let used = s.current ? String(localized: "Now") : String(localized: "Last used \(when)")
        return [used, s.place].compactMap { $0 }.joined(separator: " · ")
    }

    private func load() async {
        guard let base = appState.backendBaseURL else { return }
        do { sessions = try await ChatService.sessions(base: base); error = nil }
        catch { self.error = error.localizedDescription }
        loaded = true
    }

    private func end(_ ref: String?) async {
        guard let base = appState.backendBaseURL else { return }
        busy = true
        defer { busy = false }
        do { sessions = try await ChatService.endSessions(ref: ref, base: base); Haptics.success(); error = nil }
        catch { self.error = error.localizedDescription }
    }
}
