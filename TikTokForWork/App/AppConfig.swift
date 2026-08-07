import Foundation

enum AppConfig {
    // Local development default; production users point the app at their
    // deployment from the sign-in screen (persisted in the keychain).
    static let defaultBackendHTTP = "http://127.0.0.1:8081"

    static var backendHTTP: String {
        SessionStore.backendURL ?? defaultBackendHTTP
    }

    static var backendWS: String {
        backendHTTP
            .replacingOccurrences(of: "https://", with: "wss://")
            .replacingOccurrences(of: "http://", with: "ws://")
    }

    static var backendBaseURL: URL? {
        URL(string: backendHTTP)
    }
}
