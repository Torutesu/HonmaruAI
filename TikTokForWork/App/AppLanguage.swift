import Foundation

/// The user's UI language choice. `.system` follows the device.
enum AppLanguage: String, CaseIterable, Identifiable {
    case system
    case english = "en"
    case japanese = "ja"
    case spanish = "es"
    case french = "fr"
    case german = "de"

    var id: String { rawValue }

    var label: String {
        switch self {
        case .system: return String(localized: "System")
        case .english: return "English"
        case .japanese: return "日本語"
        case .spanish: return "Español"
        case .french: return "Français"
        case .german: return "Deutsch"
        }
    }

    /// The locale to apply, or nil to follow the system.
    var locale: Locale? {
        switch self {
        case .system: return nil
        default: return Locale(identifier: rawValue)
        }
    }

    /// The reader-language code sent to the AI, resolved against the system when `.system`.
    var readerLanguageCode: String {
        switch self {
        case .system: return AppLanguage.deviceLanguageCode
        default: return rawValue
        }
    }

    /// The device's own first language, whichever it is. Not `Locale.current`:
    /// that resolves to one of the app's own localizations, so a phone set to
    /// Vietnamese reported English and every card and notification followed.
    /// The screens can only be in the five languages above; what a person
    /// reads — cards, notifications, email — can be in any.
    static var deviceLanguageCode: String {
        for tag in Locale.preferredLanguages {
            if let code = Locale(identifier: tag).language.languageCode?.identifier { return code }
        }
        return Locale.current.language.languageCode?.identifier ?? "en"
    }
}
