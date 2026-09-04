import XCTest
@testable import TikTokForWork

/// The card's context line, broken into the facts it contains.
///
/// The router writes context as a run of short claims — "amount: ¥240,000 ·
/// deadline: Friday" — and the card renders each with its own icon. Nothing
/// tested how that string was split, and the splitting is the whole feature:
/// get it wrong and either everything is one grey blob or a sentence is
/// chopped in the middle.
final class ContextInsightsTests: XCTestCase {
    func testAnEmptyContextProducesNothing() {
        XCTAssertTrue(ContextInsights.parse("").isEmpty)
        XCTAssertTrue(ContextInsights.parse("   \n  ").isEmpty)
    }

    func testMiddleDotSeparatedClaimsBecomeSeparateFacts() {
        let insights = ContextInsights.parse("amount: ¥240,000 · deadline: Friday · scope: production")
        XCTAssertEqual(insights.count, 3)
        XCTAssertEqual(insights.compactMap(\.label), ["Amount", "Deadline", "Scope"])
        XCTAssertEqual(insights.map(\.value), ["¥240,000", "Friday", "production"])
    }

    func testEachFactIsClassifiedSoItGetsTheRightIcon() {
        let insights = ContextInsights.parse("deadline: Friday\namount: ¥240,000\nchannel: #ops")
        XCTAssertEqual(insights.map(\.kind), [.deadline, .metric, .channel])
    }

    // Matching is by keyword, so every language the app ships in needs its own
    // terms. Without them a Japanese context line loses its icon silently.
    func testJapaneseClaimsAreClassifiedToo() {
        let insights = ContextInsights.parse("期限: 金曜日 · 金額: 240,000円 · 範囲: 本番")
        XCTAssertEqual(insights.map(\.kind), [.deadline, .metric, .scope])
    }

    // A model that wrote prose instead of claims must still produce something
    // readable rather than one unbroken paragraph.
    func testProseIsSplitIntoSentencesRatherThanLeftAsOneBlock() {
        let insights = ContextInsights.parse(
            "The vendor raised their rate. We are over budget on contractors this quarter."
        )
        XCTAssertEqual(insights.count, 2)
        XCTAssertEqual(insights.first?.kind, .general)
    }

    func testASingleSentenceStaysASingleFact() {
        let insights = ContextInsights.parse("The vendor raised their rate")
        XCTAssertEqual(insights.count, 1)
        XCTAssertNil(insights.first?.label)
        XCTAssertEqual(insights.first?.value, "The vendor raised their rate")
    }

    // A colon inside a sentence is not a label. Twenty-four characters is the
    // line between "Deadline:" and a clause that happens to contain a colon.
    func testALongPrefixBeforeAColonIsNotTreatedAsALabel() {
        let insights = ContextInsights.parse(
            "The thing everyone has been waiting on since last quarter: the vendor contract"
        )
        XCTAssertEqual(insights.count, 1)
        XCTAssertNil(insights.first?.label)
    }
}
