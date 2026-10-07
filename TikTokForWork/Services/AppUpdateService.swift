import Foundation
import SwiftUI

/// Whether this build is the one people should be on.
///
/// Two sources, each for what it knows best. The App Store says what the
/// newest version is — no one has to remember to update a setting when a
/// release goes live. The Worker says the oldest version it still works
/// with, for the rare release the service cannot keep answering the old way.
///
/// A newer version is offered once per version, and again a few days later
/// if it was put off. A version the service no longer supports blocks the
/// app with one way forward.
@MainActor
final class AppUpdateService: ObservableObject {
    static let shared = AppUpdateService()

    struct Available: Equatable, Identifiable {
        let version: String
        let notes: String?
        let storeURL: URL
        var id: String { version }
    }

    /// A newer version is on the App Store.
    @Published private(set) var available: Available?
    /// This version is below what the service supports.
    @Published private(set) var required = false
    /// The newer version, offered now — nil once put off or taken.
    @Published var offer: Available?

    private var checkedAt: Date?
    private let defaults = UserDefaults.standard
    private static let snoozeKey = "update.snoozed"
    /// Put off, the offer comes back after this long.
    static let snooze: TimeInterval = 3 * 24 * 3600

    var current: String { Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0" }

    /// On launch and on coming back: at most every few hours, unless forced.
    func check(backend: URL?, force: Bool = false) async {
        // UI tests launch with `-disableUpdateCheck YES`: what the App Store
        // has (1.2.1 the day it shipped) must not put a sheet over the
        // screens a test of this build is driving.
        if defaults.bool(forKey: "disableUpdateCheck") { return }
        if !force, let at = checkedAt, Date().timeIntervalSince(at) < 4 * 3600 { return }
        checkedAt = Date()
        async let policy = Self.policy(backend: backend)
        async let store = Self.storeVersion()
        let (p, s) = await (policy, store)
        let url = p?.storeURL ?? s?.storeURL
        if let minimum = p?.minimum, Self.isOlder(current, than: minimum) {
            required = true
            if let url { available = Available(version: s?.version ?? minimum, notes: s?.notes, storeURL: url) }
            return
        }
        required = false
        guard let s, let url, Self.isOlder(current, than: s.version) else { available = nil; offer = nil; return }
        let found = Available(version: s.version, notes: s.notes, storeURL: url)
        available = found
        if shouldOffer(found.version) { offer = found }
    }

    /// "Later": asked again in a few days, or when an even newer one comes.
    func putOff() {
        if let v = offer?.version {
            defaults.set(["version": v, "at": Date().timeIntervalSince1970], forKey: Self.snoozeKey)
        }
        offer = nil
    }

    private func shouldOffer(_ version: String) -> Bool {
        guard let s = defaults.dictionary(forKey: Self.snoozeKey),
              let v = s["version"] as? String, let at = s["at"] as? Double else { return true }
        if v != version { return true }
        return Date().timeIntervalSince1970 - at > Self.snooze
    }

    // MARK: Sources

    struct Policy { let minimum: String?; let storeURL: URL? }
    struct Store { let version: String; let notes: String?; let storeURL: URL }

    private static func policy(backend: URL?) async -> Policy? {
        guard let backend, let url = URL(string: "/app/ios", relativeTo: backend) else { return nil }
        var request = URLRequest(url: url)
        request.timeoutInterval = 10
        guard let (data, response) = try? await URLSession.shared.data(for: request),
              (response as? HTTPURLResponse)?.statusCode == 200,
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        let minimum = (json["minimumVersion"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        let store = (json["storeUrl"] as? String).flatMap(URL.init(string:))
        return Policy(minimum: minimum, storeURL: store)
    }

    /// The App Store's own record of this app, in the person's storefront
    /// first and Japan's and the US's after.
    private static func storeVersion() async -> Store? {
        guard let bundle = Bundle.main.bundleIdentifier else { return nil }
        var regions = [Locale.current.region?.identifier.lowercased() ?? "jp", "jp", "us"]
        regions = regions.reduce(into: []) { if !$0.contains($1) { $0.append($1) } }
        for region in regions {
            guard let url = URL(string: "https://itunes.apple.com/lookup?bundleId=\(bundle)&country=\(region)&t=\(Int(Date().timeIntervalSince1970 / 3600))") else { continue }
            var request = URLRequest(url: url)
            request.timeoutInterval = 10
            request.cachePolicy = .reloadIgnoringLocalCacheData
            guard let (data, _) = try? await URLSession.shared.data(for: request),
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let first = (json["results"] as? [[String: Any]])?.first,
                  let version = first["version"] as? String,
                  let link = (first["trackViewUrl"] as? String).flatMap(URL.init(string:)) else { continue }
            return Store(version: version, notes: first["releaseNotes"] as? String, storeURL: link)
        }
        return nil
    }

    /// "1.0.2" is older than "1.1"; "1.0" is the same as "1.0.0".
    nonisolated static func isOlder(_ a: String, than b: String) -> Bool {
        let x = a.split(separator: ".").map { Int($0) ?? 0 }
        let y = b.split(separator: ".").map { Int($0) ?? 0 }
        for i in 0..<max(x.count, y.count) {
            let l = i < x.count ? x[i] : 0, r = i < y.count ? y[i] : 0
            if l != r { return l < r }
        }
        return false
    }
}

/// The offer and the block, on top of whatever is on screen.
struct AppUpdatePrompts: ViewModifier {
    @ObservedObject var updates: AppUpdateService
    /// The offer waits until someone is signed in; the block does not.
    let offerAllowed: Bool
    @Environment(\.openURL) private var openURL

    func body(content: Content) -> some View {
        content
            .sheet(item: Binding(get: { updates.required || !offerAllowed ? nil : updates.offer }, set: { if $0 == nil, updates.offer != nil { updates.putOff() } })) { found in
                AppUpdateOffer(found: found, current: updates.current,
                               update: { openURL(found.storeURL); updates.offer = nil },
                               later: { updates.putOff() })
                    .presentationDetents([.medium, .large])
            }
            .fullScreenCover(isPresented: .constant(updates.required)) {
                AppUpdateRequired(storeURL: updates.available?.storeURL) { if let url = updates.available?.storeURL { openURL(url) } }
            }
    }
}

struct AppUpdateOffer: View {
    let found: AppUpdateService.Available
    let current: String
    let update: () -> Void
    let later: () -> Void

    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: "arrow.down.app.fill").font(.system(size: 44)).foregroundStyle(Theme.Colors.accent).padding(.top, 28)
            Text("A new version is available").font(.title3.weight(.bold))
            Text("Version \(found.version) is on the App Store. You have \(current).")
                .font(.subheadline).foregroundStyle(Theme.Colors.textSecondary).multilineTextAlignment(.center)
            if let notes = found.notes?.trimmingCharacters(in: .whitespacesAndNewlines), !notes.isEmpty {
                ScrollView {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("What's new").font(.caption.weight(.semibold)).foregroundStyle(Theme.Colors.textTertiary)
                        Text(notes).font(.subheadline).frame(maxWidth: .infinity, alignment: .leading)
                    }.padding(14)
                }
                .frame(maxHeight: 180)
                .background(Theme.Colors.surface, in: RoundedRectangle(cornerRadius: 14))
            }
            Spacer(minLength: 0)
            Button(action: update) {
                Text("Update now").font(.headline).frame(maxWidth: .infinity).padding(.vertical, 14)
            }
            .buttonStyle(.borderedProminent).tint(Theme.Colors.accent)
            Button("Later", action: later).font(.subheadline).foregroundStyle(Theme.Colors.textSecondary).padding(.bottom, 12)
        }
        .padding(.horizontal, 24)
    }
}

struct AppUpdateRequired: View {
    let storeURL: URL?
    let update: () -> Void

    var body: some View {
        VStack(spacing: 18) {
            Spacer()
            Image(systemName: "arrow.down.app.fill").font(.system(size: 56)).foregroundStyle(Theme.Colors.accent)
            Text("Update required").font(.title2.weight(.bold))
            Text("This version no longer works with Honmaru AI. Update from the App Store to keep going — your conversations and decisions are all still there.")
                .font(.subheadline).foregroundStyle(Theme.Colors.textSecondary).multilineTextAlignment(.center)
            Spacer()
            Button(action: update) {
                Text("Update now").font(.headline).frame(maxWidth: .infinity).padding(.vertical, 14)
            }
            .buttonStyle(.borderedProminent).tint(Theme.Colors.accent)
            .disabled(storeURL == nil)
            .padding(.bottom, 24)
        }
        .padding(.horizontal, 28)
        .interactiveDismissDisabled()
    }
}
