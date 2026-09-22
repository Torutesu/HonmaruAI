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
        case .system: return Locale.current.language.languageCode?.identifier ?? "en"
        default: return rawValue
        }
    }
}
