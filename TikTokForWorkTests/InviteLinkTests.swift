import XCTest
@testable import TikTokForWork

/// A minted invite carries a link where the deployment has a web address,
/// and only a code where it does not. Both shapes must decode: the phone
/// talks to Workers older and newer than itself.
final class InviteLinkTests: XCTestCase {
    func testMintedInviteWithLink() throws {
        let data = Data(#"{"code":"abc123","orgId":"personal:x","role":"member","link":"https://honmaru-web.pages.dev/#/join/abc123","ref":"r1"}"#.utf8)
        let minted = try JSONDecoder().decode(MintedInvite.self, from: data)
        XCTAssertEqual(minted.code, "abc123")
        XCTAssertEqual(minted.link, "https://honmaru-web.pages.dev/#/join/abc123")
        XCTAssertNotNil(URL(string: minted.link ?? ""))
    }

    func testMintedInviteWithoutLinkStillDecodes() throws {
        let data = Data(#"{"code":"abc123","orgId":"personal:x","role":"member"}"#.utf8)
        let minted = try JSONDecoder().decode(MintedInvite.self, from: data)
        XCTAssertEqual(minted.code, "abc123")
        XCTAssertNil(minted.link)
        // An explicit null is the same as absent.
        let nulled = Data(#"{"code":"abc123","link":null}"#.utf8)
        XCTAssertNil(try JSONDecoder().decode(MintedInvite.self, from: nulled).link)
    }
}
