import Foundation

enum AppConfig {
    /// Where the relay server lives.
    ///
    /// On the simulator this is the Mac itself, so the loopback default works.
    /// On a physical device `127.0.0.1` is the phone, so a device demo has to
    /// point at the Mac's LAN address instead. Rather than editing this file
    /// per demo, the value is resolved in order of precedence:
    ///
    ///   1. `-RelayURL ws://…` passed as a launch argument (Xcode scheme, tests)
    ///   2. the `RelayURL` Info.plist entry, filled in from the `RELAY_URL`
    ///      build setting — this is what `scripts/device.sh` sets
    ///   3. loopback, for the simulator
    static let relayURL: String = {
        if let override = UserDefaults.standard.string(forKey: "RelayURL"),
           !override.isEmpty {
            return override
        }
        if let configured = Bundle.main.object(forInfoDictionaryKey: "RelayURL") as? String,
           !configured.isEmpty,
           // An unexpanded "$(RELAY_URL)" means the build setting was never set.
           !configured.hasPrefix("$(") {
            return configured
        }
        return "ws://127.0.0.1:8080"
    }()

    static let defaultUser = DemoUser.alice.user
}
