import XCTest
@testable import TikTokForWork

/// Explicit opt-in only: creates and deletes one disposable production account.
/// Run xcodebuild test with HONMARU_LIVE_AUTH_TEST=1. Never uses review credentials.
final class LiveEmailAuthTests: XCTestCase {
    @MainActor
    func testOrdinaryAccountPasswordLoginAndRestore() async throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["HONMARU_LIVE_AUTH_TEST"] == "1", "Live account lifecycle is opt-in")
        let base = try XCTUnwrap(BackendURL.httpBase(from: AppConfig.relayURL))
        XCTAssertEqual(base.scheme, "https")
        let email = "native-qa-\(UUID().uuidString.lowercased())@example.invalid"
        let password = UUID().uuidString
        var signup = URLRequest(url: base.appendingPathComponent("auth/signup"))
        signup.httpMethod = "POST"
        signup.timeoutInterval = 30
        signup.setValue("application/json", forHTTPHeaderField: "Content-Type")
        signup.httpBody = try JSONSerialization.data(withJSONObject: ["email": email, "password": password, "name": "Disposable native QA"])
        let (data, response) = try await URLSession.shared.data(for: signup)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        let created = try EmailAuthService.decodeSession(XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any]))
        var verificationError: Error?
        do {
            let signedIn = try await EmailAuthService.signIn(email: "\n\(email) ", password: password)
            XCTAssertEqual(signedIn.userID, created.userID)
            XCTAssertEqual(signedIn.orgId, created.orgId)
            let restored = try await EmailAuthService.restore(token: signedIn.token, baseURL: base)
            XCTAssertEqual(restored.userID, signedIn.userID)
            XCTAssertEqual(restored.orgId, signedIn.orgId)
            XCTAssertFalse(restored.orgId.isEmpty)
            let team = try await TeamService.members(orgId: restored.orgId, backendBaseURL: base, sessionToken: restored.token)
            XCTAssertEqual(team.members.filter(\.mine).count, 1)
            XCTAssertFalse(try XCTUnwrap(team.members.first(where: \.mine)).ref.isEmpty)
            let relay = WebSocketService()
            let snapshot = expectation(description: "Authenticated workspace snapshot")
            snapshot.assertForOverFulfill = false
            relay.onEvent = { event in
                if case .snapshot = event { snapshot.fulfill() }
            }
            defer { relay.disconnect() }
            try await relay.connect(urlString: AppConfig.relayURL, userId: restored.login, orgId: restored.orgId, sessionToken: restored.token)
            await fulfillment(of: [snapshot], timeout: 25)
            XCTAssertEqual(relay.state, .connected, "Password login is not sufficient: workspace join must succeed")
            // Exercise the native sender and decoder, not a separate Node client.
            let cardID = UUID().uuidString
            let echo = expectation(description: "Persisted card echoed from relay")
            echo.assertForOverFulfill = false
            relay.onEvent = { event in
                if case .cardCreated(let card) = event, card.id == cardID { echo.fulfill() }
                if case .cardUpdated(let card) = event, card.id == cardID { echo.fulfill() }
            }
            let card = DecisionCard(id: cardID, recipientUserID: restored.login, senderUserID: restored.login,
                                    type: .approval, title: "Native QA", summary: "Disposable test", context: "",
                                    status: .pending, priority: .medium, createdAt: .now)
            await relay.publishCreated(card)
            await fulfillment(of: [echo], timeout: 20)
            relay.disconnect()
            let recovered = expectation(description: "Card survives reconnection")
            recovered.assertForOverFulfill = false
            relay.onEvent = { event in
                if case .snapshot(let cards, _) = event, cards.values.flatMap({ $0 }).contains(where: { $0.id == cardID }) {
                    recovered.fulfill()
                }
            }
            try await relay.connect(urlString: AppConfig.relayURL, userId: restored.login, orgId: restored.orgId, sessionToken: restored.token)
            await fulfillment(of: [recovered], timeout: 20)
        } catch { verificationError = error }
        // Cleanup runs even if the login or restore request fails.
        var deletion = URLRequest(url: base.appendingPathComponent("account"))
        deletion.httpMethod = "DELETE"
        deletion.timeoutInterval = 30
        deletion.setValue(created.token, forHTTPHeaderField: "x-session-token")
        let (_, deleted) = try await URLSession.shared.data(for: deletion)
        XCTAssertEqual((deleted as? HTTPURLResponse)?.statusCode, 200, "Disposable account cleanup must succeed")
        if let verificationError { throw verificationError }
    }
}
