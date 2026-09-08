import RevenueCat
import XCTest
@testable import TikTokForWork

final class AccountLifecycleTests: XCTestCase {
    @MainActor
    func testAnOldBillingSignOutCannotFinishAfterTheNewLogin() async {
        let client = DeferredBillingIdentity()
        let service = SubscriptionService(identityClient: client)
        let started = expectation(description: "old sign-out reached the SDK")
        client.onDeferredStart = { started.fulfill() }
        let old = Task { await service.signOut() }
        await fulfillment(of: [started], timeout: 2)
        let newStarted = expectation(description: "new identity requested")
        let current = Task { newStarted.fulfill(); await service.identify("new-account") }
        await fulfillment(of: [newStarted], timeout: 2)
        await Task.yield()
        XCTAssertEqual(client.calls, ["logout"])
        client.finishDeferred()
        await old.value
        await current.value
        XCTAssertEqual(client.calls, ["logout", "login:new-account"])
        XCTAssertEqual(client.appUserID, "new-account")
    }

    @MainActor
    func testAnOldBillingFailureCannotReplaceTheNewAccountsState() async {
        let client = DeferredBillingIdentity()
        client.deferLogin = true
        let service = SubscriptionService(identityClient: client)
        let started = expectation(description: "old login reached the SDK")
        client.onDeferredStart = { started.fulfill() }
        let old = Task { await service.identify("old-account") }
        await fulfillment(of: [started], timeout: 2)
        let newStarted = expectation(description: "new identity requested")
        let current = Task { newStarted.fulfill(); await service.identify("new-account") }
        await fulfillment(of: [newStarted], timeout: 2)
        await Task.yield()
        client.finishDeferred(error: URLError(.notConnectedToInternet))
        await old.value
        await current.value
        XCTAssertEqual(client.appUserID, "new-account")
        XCTAssertNil(service.errorMessage)
    }

    @MainActor
    func testAFailedCurrentBillingLoginKeepsTheOldAccountsEntitlementsUnavailable() async {
        let client = DeferredBillingIdentity()
        client.deferLogin = true
        let service = SubscriptionService(identityClient: client)
        let started = expectation(description: "new login reached the SDK")
        client.onDeferredStart = { started.fulfill() }
        let current = Task { await service.identify("new-account") }
        await fulfillment(of: [started], timeout: 2)
        client.finishDeferred(error: URLError(.notConnectedToInternet))
        await current.value
        XCTAssertEqual(client.appUserID, "old-account")
        XCTAssertFalse(service.isIdentityReady)
        XCTAssertFalse(service.isPro)
        XCTAssertNil(service.customerInfo)
        let restored = await service.restorePurchases()
        XCTAssertFalse(restored)
        XCTAssertNotNil(service.errorMessage)
    }

    @MainActor
    func testACompletedAccountDeletionDoesNotSignOutAReplacementSession() async throws {
        defer { DeferredAccountProtocol.onRequest = nil }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [DeferredAccountProtocol.self]
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel() }
        let app = AppState(startServices: false, accountSession: session, accountToken: { "native-unit-test-token" })
        let requested = expectation(description: "account deletion requested")
        var pending: DeferredAccountProtocol?
        DeferredAccountProtocol.onRequest = { value in pending = value; requested.fulfill() }
        let deletion = Task { try await app.deleteAccount() }
        await fulfillment(of: [requested], timeout: 2)
        app.activateGuestSession()
        let replacementID = app.activeSessionID
        pending?.complete()
        try await deletion.value
        XCTAssertTrue(app.isAuthenticated)
        XCTAssertTrue(app.isGuest)
        XCTAssertEqual(app.activeSessionID, replacementID)
        XCTAssertEqual(app.currentUser?.id, DemoWorkspace.userID)
    }
}

@MainActor
private final class DeferredBillingIdentity: SubscriptionIdentityClient {
    let isConfigured = true
    private(set) var appUserID: String? = "old-account"
    var isAnonymous: Bool { appUserID == nil }
    var deferLogin = false
    var onDeferredStart: (() -> Void)?
    private(set) var calls: [String] = []
    private var continuation: CheckedContinuation<Void, Error>?

    func logIn(_ userID: String) async throws -> CustomerInfo? {
        calls.append("login:\(userID)")
        if deferLogin {
            deferLogin = false
            try await suspend()
        }
        appUserID = userID
        return nil
    }
    func logOut() async throws -> CustomerInfo? {
        calls.append("logout")
        try await suspend()
        appUserID = nil
        return nil
    }
    private func suspend() async throws {
        try await withCheckedThrowingContinuation { value in
            continuation = value
            onDeferredStart?()
        }
    }
    func finishDeferred(error: Error? = nil) {
        if let error { continuation?.resume(throwing: error) }
        else { continuation?.resume() }
        continuation = nil
    }
}

private final class DeferredAccountProtocol: URLProtocol {
    @MainActor static var onRequest: ((DeferredAccountProtocol) -> Void)?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() { Task { @MainActor in Self.onRequest?(self) } }
    override func stopLoading() {}
    func complete() {
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data("{}".utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
}
