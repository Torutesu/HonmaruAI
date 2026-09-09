import Foundation
import ObjectiveC

/// Runtime UI-language switching for the string catalog.
///
/// SwiftUI's `\.environment(\.locale)` changes locale-based *formatting* but does
/// NOT change which localization the string catalog resolves — that is driven by
/// `Bundle.main`. To switch the app language live (without a relaunch), we swap
/// `Bundle.main`'s class for one that forwards `localizedString(forKey:…)` to the
/// chosen `.lproj` bundle. Modern `String(localized:)` can bypass this Objective-C
/// override, so its app-local overload below supplies the bundle explicitly.
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

enum AppLocalization {
    static var language: AppLanguage {
        AppLanguage(rawValue: UserDefaults.standard.string(forKey: "appLanguage") ?? "system") ?? .system
    }

    static var locale: Locale { language.locale ?? .autoupdatingCurrent }

    static var bundle: Bundle {
        guard let code = language.locale?.identifier,
              let path = Bundle.main.path(forResource: code, ofType: "lproj"),
              let bundle = Bundle(path: path) else { return .main }
        return bundle
    }
}

extension String {
    /// This exact one-argument overload covers app UI, model labels and errors.
    /// Passing both bundle and locale explicitly also preserves interpolated
    /// catalog values when the in-app language differs from the device language.
    init(localized key: String.LocalizationValue) {
        self.init(localized: key, bundle: AppLocalization.bundle, locale: AppLocalization.locale)
    }
}
