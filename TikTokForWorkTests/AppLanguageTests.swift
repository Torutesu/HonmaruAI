import XCTest
@testable import TikTokForWork

/// The language picker is the single surface every localized string depends
/// on: the enum case has to map to the bundle folder (es.lproj), the label
/// has to be the name a reader of that language recognizes, and the code sent
/// to the AI has to be the primary subtag the Worker stores.
final class AppLanguageTests: XCTestCase {

    func testEveryCaseHasANativeLabelAndABundleLocale() {
        for language in AppLanguage.allCases where language != .system {
            XCTAssertEqual(language.locale?.language.languageCode?.identifier, language.rawValue,
                           "\(language) must resolve to a \(language.rawValue) bundle")
            XCTAssertFalse(language.label.isEmpty)
            // The label is the language's own name for itself, not an
            // English name a reader would have to translate.
            XCTAssertNotEqual(language.label, language.rawValue.capitalized)
        }
    }

    func testReaderLanguageCodeIsThePrimarySubtag() {
        XCTAssertEqual(AppLanguage.spanish.readerLanguageCode, "es")
        XCTAssertEqual(AppLanguage.french.readerLanguageCode, "fr")
        XCTAssertEqual(AppLanguage.german.readerLanguageCode, "de")
        XCTAssertEqual(AppLanguage.english.readerLanguageCode, "en")
        XCTAssertEqual(AppLanguage.japanese.readerLanguageCode, "ja")
        // .system follows the device rather than inventing a value.
        XCTAssertFalse(AppLanguage.system.readerLanguageCode.isEmpty)
    }

    func testSystemFollowsTheDevice() {
        XCTAssertNil(AppLanguage.system.locale)
    }

    func testNativeLabels() {
        XCTAssertEqual(AppLanguage.spanish.label, "Español")
        XCTAssertEqual(AppLanguage.french.label, "Français")
        XCTAssertEqual(AppLanguage.german.label, "Deutsch")
    }
}
