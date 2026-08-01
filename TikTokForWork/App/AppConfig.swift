import Foundation

enum AppConfig {
    static let relayURL = "ws://127.0.0.1:8080"
    static let defaultUser = DemoUser.alice.user
}

/// UserDefaults keys that gate one-time first-run moments.
enum FirstRunFlags {
    static let seededFeed = "didSeedDemoFeed"
    static let promptedGitHubConnect = "didPromptGitHubConnect"
}
