import Foundation

enum AppConfig {
    // Protocol v1 backend (backend/ in this repo). Point at your deployed
    // host in production builds.
    static let backendHTTP = "http://127.0.0.1:8081"
    static let backendWS = "ws://127.0.0.1:8081"

    static var backendBaseURL: URL? {
        URL(string: backendHTTP)
    }
}
