import Foundation
import Security

enum SessionStore {
    private static let service = "com.tangle.tiktokforwork.session"

    private enum Key {
        static let githubToken = "githubToken"
        static let githubRepository = "githubRepository"
        static let githubUsername = "githubUsername"
        static let githubRepositoryURL = "githubRepositoryURL"
        static let currentUserID = "currentUserID"
        static let relayURL = "relayURL"
        static let relayToken = "relayToken"
    }

    static var githubToken: String? {
        get { read(Key.githubToken) }
        set { write(newValue, key: Key.githubToken) }
    }

    static var githubRepository: String? {
        get { read(Key.githubRepository) }
        set { write(newValue, key: Key.githubRepository) }
    }

    static var githubUsername: String? {
        get { read(Key.githubUsername) }
        set { write(newValue, key: Key.githubUsername) }
    }

    static var githubRepositoryURL: String? {
        get { read(Key.githubRepositoryURL) }
        set { write(newValue, key: Key.githubRepositoryURL) }
    }

    static var currentUserID: String? {
        get { read(Key.currentUserID) }
        set { write(newValue, key: Key.currentUserID) }
    }

    // Device-level relay config — survives sign-out on purpose,
    // so clear() must not touch these keys.
    static var relayURL: String? {
        get { read(Key.relayURL) }
        set { write(newValue, key: Key.relayURL) }
    }

    static var relayToken: String? {
        get { read(Key.relayToken) }
        set { write(newValue, key: Key.relayToken) }
    }

    static var hasSavedGitHubSession: Bool {
        guard let token = githubToken, !token.isEmpty,
              let repository = githubRepository, !repository.isEmpty else {
            return false
        }
        return true
    }

    static func saveGitHubConnection(_ connection: GitHubConnection, token: String, repository: String) {
        githubToken = token
        githubRepository = repository
        githubUsername = connection.username
        githubRepositoryURL = connection.repositoryURL
    }

    static func saveGitHubToken(_ token: String) {
        githubToken = token
    }

    static func clear() {
        delete(Key.githubToken)
        delete(Key.githubRepository)
        delete(Key.githubUsername)
        delete(Key.githubRepositoryURL)
        delete(Key.currentUserID)
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
        SecItemAdd(query as CFDictionary, nil)
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
