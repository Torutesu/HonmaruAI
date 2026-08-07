import Foundation
import Security

// Keychain-backed session state for the protocol v1 backend.
enum SessionStore {
    private static let service = "com.tangle.tiktokforwork.session"

    private enum Key {
        static let sessionToken = "sessionToken"
        static let userID = "userID"
        static let userName = "userName"
        static let orgID = "orgID"
        static let orgName = "orgName"
        static let backendURL = "backendURL"
    }

    // Device-level setting: survives sign-out.
    static var backendURL: String? {
        get { read(Key.backendURL) }
        set { write(newValue, key: Key.backendURL) }
    }

    static var sessionToken: String? {
        get { read(Key.sessionToken) }
        set { write(newValue, key: Key.sessionToken) }
    }

    static var userID: String? {
        get { read(Key.userID) }
        set { write(newValue, key: Key.userID) }
    }

    static var userName: String? {
        get { read(Key.userName) }
        set { write(newValue, key: Key.userName) }
    }

    static var orgID: String? {
        get { read(Key.orgID) }
        set { write(newValue, key: Key.orgID) }
    }

    static var orgName: String? {
        get { read(Key.orgName) }
        set { write(newValue, key: Key.orgName) }
    }

    static var hasSavedSession: Bool {
        guard let token = sessionToken, !token.isEmpty,
              let orgID, !orgID.isEmpty else {
            return false
        }
        return true
    }

    static func save(token: String, userID: String, userName: String, orgID: String, orgName: String) {
        sessionToken = token
        self.userID = userID
        self.userName = userName
        self.orgID = orgID
        self.orgName = orgName
    }

    static func clear() {
        delete(Key.sessionToken)
        delete(Key.userID)
        delete(Key.userName)
        delete(Key.orgID)
        delete(Key.orgName)
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
