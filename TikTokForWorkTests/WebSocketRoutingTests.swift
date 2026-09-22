import XCTest
@testable import TikTokForWork

@MainActor
final class WebSocketRoutingTests: XCTestCase {
    func testOrganizationIsPresentBeforeWebSocketUpgrade() throws {
        let url = try XCTUnwrap(WebSocketService.connectionURL(relayURL: "wss://relay.example.test", orgID: "company/team"))
        let components = try XCTUnwrap(URLComponents(url: url, resolvingAgainstBaseURL: false))
        XCTAssertEqual(components.queryItems, [URLQueryItem(name: "orgId", value: "company/team")])
    }

    func testCurrentTeamReplacesStaleQueryWithoutDroppingOtherParameters() throws {
        let url = try XCTUnwrap(WebSocketService.connectionURL(relayURL: "wss://relay.example.test/socket?orgId=old&mode=mobile&orgId=older", orgID: "日本語 & team"))
        let items = try XCTUnwrap(URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems)
        XCTAssertEqual(items.filter { $0.name == "orgId" }.map(\.value), ["日本語 & team"])
        XCTAssertTrue(items.contains(URLQueryItem(name: "mode", value: "mobile")))
        XCTAssertEqual(url.path, "/socket")
    }

    func testMissingTeamCannotSilentlyJoinCoreTeam() {
        XCTAssertNil(WebSocketService.connectionURL(relayURL: "wss://relay.example.test", orgID: ""))
        XCTAssertNil(WebSocketService.connectionURL(relayURL: "https://relay.example.test", orgID: "team"))
    }
}
