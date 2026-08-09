import Foundation

/// The user's UI language choice. `.system` follows the device.
enum AppLanguage: String, CaseIterable, Identifiable {
    case system
    case english = "en"
    case japanese = "ja"

    var id: String { rawValue }

    var label: String {
        switch self {
        case .system: return String(localized: "System")
        case .english: return "English"
        case .japanese: return "日本語"
        }
    }

    /// The locale to apply, or nil to follow the system.
    var locale: Locale? {
        switch self {
        case .system: return nil
        case .english: return Locale(identifier: "en")
        case .japanese: return Locale(identifier: "ja")
        }
    }

    /// The reader-language code sent to the AI, resolved against the system when `.system`.
    var readerLanguageCode: String {
        switch self {
        case .system: return Locale.current.language.languageCode?.identifier ?? "en"
        case .english: return "en"
        case .japanese: return "ja"
        }
    }
}
