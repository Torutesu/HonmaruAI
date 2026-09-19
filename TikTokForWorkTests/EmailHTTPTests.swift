import XCTest
@testable import TikTokForWork

final class EmailHTTPTests: XCTestCase {
    private var session: URLSession!
    private let base = URL(string: "https://auth.example.test")!

    override func setUp() {
        super.setUp()
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [AuthTestProtocol.self]
        session = URLSession(configuration: config)
    }

    override func tearDown() {
        session.invalidateAndCancel()
        AuthTestProtocol.handler = nil
        super.tearDown()
    }

    func testPasswordRequestAndServerIdentity() async throws {
        AuthTestProtocol.handler = { request in
            XCTAssertEqual(request.url?.absoluteString, "https://auth.example.test/auth/login")
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertEqual(request.value(forHTTPHeaderField: "content-type"), "application/json")
            let body = try Self.body(request)
            XCTAssertEqual(body["email"] as? String, "member@example.com")
            XCTAssertEqual(body["password"] as? String, " unchanged password ")
            return (200, #"{"token":"session","login":"member","userId":"email:member@example.com","orgId":"team"}"#)
        }
        let result = try await EmailAuthService.signIn(email: " \nMember@example.com\r\n", password: " unchanged password ", baseURL: base, session: session)
        XCTAssertEqual(result.userID, "email:member@example.com")
        XCTAssertEqual(result.orgId, "team")
    }

    func testOTPRequestAndVerification() async throws {
        AuthTestProtocol.handler = { request in
            let body = try Self.body(request)
            XCTAssertEqual(body["email"] as? String, "member@example.com")
            if request.url?.path == "/auth/otp/request" { return (200, "{}") }
            XCTAssertEqual(request.url?.path, "/auth/otp/verify")
            XCTAssertEqual(body["code"] as? String, "012345")
            XCTAssertEqual(body["inviteCode"] as? String, "invite")
            return (200, #"{"token":"session","login":"member","userId":"email:member@example.com","orgId":null,"created":true}"#)
        }
        try await EmailAuthService.requestCode(email: "Member@example.com\n", baseURL: base, session: session)
        let result = try await EmailAuthService.verifyCode(email: "Member@example.com\n", code: "012345", name: "Member", inviteCode: "invite", baseURL: base, session: session)
        XCTAssertTrue(result.created)
        XCTAssertEqual(result.orgId, "")
    }

    func testPasswordServerOutageDoesNotSuggestPasswordFallback() async {
        AuthTestProtocol.handler = { _ in (503, "{}") }
        do {
            _ = try await EmailAuthService.signIn(email: "member@example.com", password: "password", baseURL: base, session: session)
            XCTFail("Expected server failure")
        } catch EmailAuthService.Failure.unreachable { } catch { XCTFail("Unexpected: \(error)") }
    }

    func testWrongPasswordPreservesServerMessage() async {
        AuthTestProtocol.handler = { _ in (401, #"{"message":"Invalid credentials"}"#) }
        do {
            _ = try await EmailAuthService.signIn(email: "member@example.com", password: "wrong", baseURL: base, session: session)
            XCTFail("Expected rejection")
        } catch EmailAuthService.Failure.message(let message) {
            XCTAssertEqual(message, "Invalid credentials")
        } catch { XCTFail("Unexpected: \(error)") }
    }

    func testMalformedSuccessDoesNotCreateSession() async {
        AuthTestProtocol.handler = { _ in (200, #"{"token":"session"}"#) }
        do {
            _ = try await EmailAuthService.signIn(email: "member@example.com", password: "password", baseURL: base, session: session)
            XCTFail("Expected malformed response rejection")
        } catch EmailAuthService.Failure.unreachable { } catch { XCTFail("Unexpected: \(error)") }
    }

    private static func body(_ request: URLRequest) throws -> [String: Any] {
        var data = request.httpBody ?? Data()
        if let stream = request.httpBodyStream {
            stream.open()
            defer { stream.close() }
            var buffer = [UInt8](repeating: 0, count: 1024)
            while stream.hasBytesAvailable {
                let count = stream.read(&buffer, maxLength: buffer.count)
                guard count > 0 else { break }
                data.append(contentsOf: buffer.prefix(count))
            }
        }
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }
}

private final class AuthTestProtocol: URLProtocol {
    static var handler: ((URLRequest) throws -> (Int, String))?
    override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "auth.example.test" }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        do {
            let (status, body) = try XCTUnwrap(Self.handler)(request)
            let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: Data(body.utf8))
            client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() {}
}
