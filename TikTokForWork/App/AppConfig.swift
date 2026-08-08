import Foundation

enum AppConfig {
    /// Where the relay server lives.
    ///
    /// On the simulator this is the Mac itself, so loopback works. On a phone
    /// `127.0.0.1` is the phone, so a device build has to point at the Mac's
    /// LAN address instead. Rather than editing this file per demo, the value
    /// resolves in order of precedence:
    ///
    ///   1. `-RelayURL ws://…` as a launch argument (Xcode scheme, tests)
    ///   2. the `RelayURL` Info.plist entry, joined from the `RELAY_SCHEME` and
    ///      `RELAY_HOST` build settings — what `scripts/device.sh` writes
    ///   3. loopback, for the simulator
    static let relayURL: String = {
        if let override = UserDefaults.standard.string(forKey: "RelayURL"),
           !override.isEmpty {
            return override
        }
        if let configured = Bundle.main.object(forInfoDictionaryKey: "RelayURL") as? String,
           !configured.isEmpty,
           // An unexpanded "$(…)" means the build setting was never set.
           !configured.hasPrefix("$(") {
            return configured
        }
        return "ws://127.0.0.1:8080"
    }()

    static let defaultUser = DemoUser.alice.user
}

/// UserDefaults keys that gate one-time first-run moments.
enum FirstRunFlags {
    static let seededFeed = "didSeedDemoFeed"
    static let promptedGitHubConnect = "didPromptGitHubConnect"
}
