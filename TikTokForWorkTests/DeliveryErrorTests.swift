import XCTest
@testable import TikTokForWork

final class DeliveryErrorTests: XCTestCase {
    func testUnknownEventTypesDoNotBecomeFalseDeliveryFailures() throws {
        let data = Data(#"{"type":"future_event","payload":{}}"#.utf8)
        XCTAssertThrowsError(try JSONDecoder().decode(RealtimeEvent.self, from: data))
        let actualFailure = Data(#"{"type":"error","payload":{"message":"Rejected"}}"#.utf8)
        guard case .error(let message) = try JSONDecoder().decode(RealtimeEvent.self, from: actualFailure) else {
            return XCTFail("Real relay failures must still be decoded")
        }
        XCTAssertEqual(message, "Rejected")
    }

    @MainActor
    func testARejectedMutationIsVisibleToTheUser() {
        let socket = WebSocketService()
        socket.reportRelayError("Card was rejected by the server", wasJoined: true)
        XCTAssertEqual(socket.deliveryError, "Card was rejected by the server")
        socket.clearDeliveryError()
        XCTAssertNil(socket.deliveryError)
    }

    @MainActor
    func testJoinRefusalIsNotMisreportedAsASendFailure() {
        let socket = WebSocketService()
        socket.reportRelayError("Not a member of this organization", wasJoined: false)
        XCTAssertNil(socket.deliveryError)
    }

    @MainActor
    func testSignOutClearsThePreviousAccountsDeliveryError() {
        let socket = WebSocketService()
        socket.reportRelayError("Old account's private error", wasJoined: true)
        socket.disconnect()
        socket.clearPendingEvents()
        XCTAssertNil(socket.deliveryError)
    }

    @MainActor
    func testSwitchingScopeClearsAnErrorEvenWhenTheNewConnectionFails() async {
        let socket = WebSocketService()
        socket.reportRelayError("Previous organization's error", wasJoined: true)
        // Invalid URL prevents any network request while exercising connect's
        // identity transition, which must happen before a failed join too.
        do {
            try await socket.connect(urlString: "wss://[", userId: "bob", orgId: "other/app")
            XCTFail("The URL should be rejected locally")
        } catch { }
        XCTAssertNil(socket.deliveryError)
        socket.disconnect()
        socket.clearPendingEvents()
    }

    @MainActor
    func testRelayMessagesHaveABoundedDisplayLength() {
        let socket = WebSocketService()
        socket.reportRelayError(String(repeating: "x", count: 10_000), wasJoined: true)
        XCTAssertEqual(socket.deliveryError?.count, 500)
    }
}
