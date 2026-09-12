import XCTest
@testable import TikTokForWork

final class WorkspaceMemberServiceTests: XCTestCase {
    override func tearDown() {
        MemberProtocol.reset()
        super.tearDown()
    }

    func testRetriesATransientServerFailureAndReturnsMembers() async throws {
        MemberProtocol.enqueue(status: 503, body: Data())
        MemberProtocol.enqueue(
            status: 200,
            body: Data(#"{"orgId":"org-1","members":[{"id":"member-1","name":"Mika","role":"Design","avatarUrl":null}]}"#.utf8)
        )

        let members = try await WorkspaceMemberService.fetch(
            orgID: "org-1",
            baseURL: URL(string: "https://example.com")!,
            sessionToken: "session-token",
            session: makeSession(),
            maxAttempts: 2
        )

        XCTAssertEqual(members.map(\.id), ["member-1"])
        XCTAssertEqual(MemberProtocol.requestCount, 2)
        XCTAssertEqual(MemberProtocol.lastRequest?.value(forHTTPHeaderField: "x-session-token"), "session-token")
        XCTAssertEqual(MemberProtocol.lastRequest?.url?.query, "orgId=org-1")
    }

    func testDoesNotRetryAnAuthenticationFailure() async {
        MemberProtocol.enqueue(status: 401, body: Data())

        do {
            _ = try await WorkspaceMemberService.fetch(
                orgID: "org-1",
                baseURL: URL(string: "https://example.com")!,
                sessionToken: "expired-token",
                session: makeSession(),
                maxAttempts: 3
            )
            XCTFail("Expected the request to fail")
        } catch {
            XCTAssertEqual(MemberProtocol.requestCount, 1)
        }
    }

    private func makeSession() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [MemberProtocol.self]
        return URLSession(configuration: configuration)
    }
}

private final class MemberProtocol: URLProtocol {
    private struct Stub {
        let status: Int
        let body: Data
    }

    private static let lock = NSLock()
    private static var stubs: [Stub] = []
    private static var requests: [URLRequest] = []

    static var requestCount: Int { lock.withLock { requests.count } }
    static var lastRequest: URLRequest? { lock.withLock { requests.last } }

    static func enqueue(status: Int, body: Data) {
        lock.withLock { stubs.append(Stub(status: status, body: body)) }
    }

    static func reset() {
        lock.withLock {
            stubs = []
            requests = []
        }
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let stub: Stub? = Self.lock.withLock {
            Self.requests.append(request)
            return Self.stubs.isEmpty ? nil : Self.stubs.removeFirst()
        }
        guard let stub else {
            client?.urlProtocol(self, didFailWithError: URLError(.resourceUnavailable))
            return
        }
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: stub.status,
            httpVersion: nil,
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: stub.body)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}
