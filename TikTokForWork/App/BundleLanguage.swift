import Foundation
import ObjectiveC

/// Runtime UI-language switching for the string catalog.
///
/// SwiftUI's `\.environment(\.locale)` changes locale-based *formatting* but does
/// NOT change which localization the string catalog resolves — that is driven by
/// `Bundle.main`. To switch the app language live (without a relaunch), we swap
/// `Bundle.main`'s class for one that forwards `localizedString(forKey:…)` to the
/// chosen `.lproj` bundle. This covers both `Text("key")` and `String(localized:)`
/// because both route through `Bundle.main.localizedString`.
private final class LanguageBundle: Bundle, @unchecked Sendable {
    override func localizedString(forKey key: String, value: String?, table tableName: String?) -> String {
        if let override = objc_getAssociatedObject(self, &LanguageBundle.key) as? Bundle {
            return override.localizedString(forKey: key, value: value, table: tableName)
        }
        return super.localizedString(forKey: key, value: value, table: tableName)
    }

    nonisolated(unsafe) static var key: UInt8 = 0
}

extension Bundle {
    /// Point `Bundle.main` at the given language code's `.lproj` (e.g. "en", "ja"),
    /// or pass nil to follow the system. Safe to call repeatedly.
    static func setAppLanguage(_ code: String?) {
        object_setClass(Bundle.main, LanguageBundle.self)
        let override: Bundle?
        if let code,
           let path = Bundle.main.path(forResource: code, ofType: "lproj"),
           let lproj = Bundle(path: path) {
            override = lproj
        } else {
            override = nil
        }
        objc_setAssociatedObject(Bundle.main, &LanguageBundle.key, override, .OBJC_ASSOCIATION_RETAIN)
    }
}
