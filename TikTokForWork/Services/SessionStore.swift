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
        static let orgId = "orgId"
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

    /// The organization an email session belongs to. A GitHub session gets its
    /// org from the repository it picked; an email one is told by the server
    /// (a team invite's org, or one of the person's own), and there is nowhere
    /// else to derive it from on the next launch.
    static var orgId: String? {
        get { read(Key.orgId) }
        set { write(newValue, key: Key.orgId) }
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
        isGitHubSession(token: sessionToken, repository: githubRepository)
    }

    /// An email session: a token and the org it is for, with no repository and
    /// no GitHub username. Kept apart from `hasSavedGitHubSession` because the
    /// two restore along different paths.
    static var hasSavedEmailSession: Bool {
        isEmailSession(token: sessionToken, user: currentUserID, repository: githubRepository)
    }

    /// Which kind of session a set of stored values describes.
    ///
    /// Separated from where those values live because the values live in the
    /// keychain, and a keychain write from a test bundle is not something a
    /// test can rely on succeeding — so the rule that decides which restore
    /// path a launch takes would otherwise be untestable, which is exactly
    /// backwards for the one piece of this that can send someone down the
    /// wrong one.
    ///
    /// The two are mutually exclusive by construction: a stored repository
    /// makes it a GitHub session and nothing else. Sharing one flag would let
    /// a GitHub launch take the email path, which skips validating the
    /// repository the session is for.
    static func isGitHubSession(token: String?, repository: String?) -> Bool {
        guard let token, !token.isEmpty, let repository, !repository.isEmpty else { return false }
        return true
    }

    static func isEmailSession(token: String?, user: String?, repository: String?) -> Bool {
        guard let token, !token.isEmpty, let user, !user.isEmpty else { return false }
        return (repository ?? "").isEmpty
    }

    static func saveGitHubConnection(_ connection: GitHubConnection, repository: String) {
        githubRepository = repository
        githubUsername = connection.username
        githubRepositoryURL = connection.repositoryURL
    }

    /// Everything signing out forgets.
    ///
    /// A list rather than a run of `delete` calls, so that adding something to
    /// the store and forgetting it here is a thing a test can catch. What it
    /// would cost: the next account on this phone inheriting the last one's
    /// organization, or its session.
    ///
    /// `apiKey` is deliberately absent — it is the person's own OpenAI key,
    /// which belongs to the device and not to the session.
    static let clearedKeys = [
        Key.githubRepository, Key.githubUsername, Key.githubUserId,
        Key.githubRepositoryURL, Key.currentUserID, Key.sessionToken, Key.orgId,
    ]

    static func clear() {
        clearedKeys.forEach { delete($0) }
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
