import Foundation
import Security

enum SessionStore {
    private static let service = "com.tangle.tiktokforwork.session"

    private enum Key {
        static let githubRepository = "githubRepository"
        static let githubUsername = "githubUsername"
        static let githubUserId = "githubUserId"
        static let githubRepositoryURL = "githubRepositoryURL"
        static let currentUserID = "currentUserID"
        static let sessionToken = "sessionToken"
        static let apiKey = "apiKey"
    }

    static var githubRepository: String? {
        get { read(Key.githubRepository) }
        set { write(newValue, key: Key.githubRepository) }
    }

    static var githubUsername: String? {
        get { read(Key.githubUsername) }
        set { write(newValue, key: Key.githubUsername) }
    }

    /// The numeric GitHub id, kept so RevenueCat can be identified by the same value the
    /// Worker uses to look up entitlements.
    static var githubUserId: String? {
        get { read(Key.githubUserId) }
        set { write(newValue, key: Key.githubUserId) }
    }

    static var githubRepositoryURL: String? {
        get { read(Key.githubRepositoryURL) }
        set { write(newValue, key: Key.githubRepositoryURL) }
    }

    static var currentUserID: String? {
        get { read(Key.currentUserID) }
        set { write(newValue, key: Key.currentUserID) }
    }

    static var sessionToken: String? {
        get { read(Key.sessionToken) }
        set { write(newValue, key: Key.sessionToken) }
    }

    static var apiKey: String? {
        get { read(Key.apiKey) }
        set { write(newValue, key: Key.apiKey) }
    }

    /// A GitHub access token is never stored, because it is never received.
    /// It carries `repo` scope — every repository the person can reach, code
    /// included — and the app opens issues. It stays on the relay, which
    /// forwards the handful of calls this app makes and refuses the rest.
    /// What is kept here is the relay session.
    static var hasSavedGitHubSession: Bool {
        guard let session = sessionToken, !session.isEmpty,
              let repository = githubRepository, !repository.isEmpty else {
            return false
        }
        return true
    }

    static func saveGitHubConnection(_ connection: GitHubConnection, repository: String) {
        githubRepository = repository
        githubUsername = connection.username
        githubRepositoryURL = connection.repositoryURL
    }

    static func clear() {
        delete(Key.githubRepository)
        delete(Key.githubUsername)
        delete(Key.githubUserId)
        delete(Key.githubRepositoryURL)
        delete(Key.currentUserID)
        delete(Key.sessionToken)
    }

    private static func read(_ key: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]

        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        guard status == errSecSuccess, let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    private static func write(_ value: String?, key: String) {
        delete(key)
        guard let value, !value.isEmpty else { return }

        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
            kSecValueData as String: Data(value.utf8),
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        // A dropped return value here meant a failed write looked exactly like a
        // successful one: the token was simply not there next launch, and the
        // person was signed out for no reason anyone could see.
        let status = SecItemAdd(query as CFDictionary, nil)
        if status != errSecSuccess {
            print("SessionStore: could not store \(key) (OSStatus \(status))")
        }
    }

    private static func delete(_ key: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]
        SecItemDelete(query as CFDictionary)
    }
}
