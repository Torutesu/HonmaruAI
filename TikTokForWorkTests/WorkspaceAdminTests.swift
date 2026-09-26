import XCTest
@testable import TikTokForWork

/// The admin screens read the Worker's answers as the web does: data rules,
/// compliance settings, holds, exports, SSO connections and audit streams.
final class WorkspaceAdminTests: XCTestCase {
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(type, from: Data(json.utf8))
    }

    func testDataRulesDecode() throws {
        let rules = try decode(AdminService.DataRules.self, """
        {"rules":[
          {"id":"r1","name":"Card number","kind":"builtin","detector":"credit_card","pattern":null,"keywords":null,"action":"block","enabled":true,"updatedAt":"2026-09-26T00:00:00Z"},
          {"id":"r2","name":"Project names","kind":"keywords","detector":null,"pattern":null,"keywords":["Bluebird","Kestrel"],"action":"warn","enabled":false,"updatedAt":"2026-09-26T00:00:00Z"}
        ],"detectors":[{"id":"credit_card","name":"Card number"}],"canEdit":true}
        """)
        XCTAssertEqual(rules.rules.count, 2)
        XCTAssertEqual(rules.rules[1].keywords, ["Bluebird", "Kestrel"])
        XCTAssertFalse(rules.rules[1].enabled)
        XCTAssertTrue(rules.canEdit)
    }

    func testComplianceAnswersDecode() throws {
        let g = try decode(AdminService.Governance.self, """
        {"retention":{"publicDays":365,"privateDays":null,"dmDays":30,"filesDays":null},
         "network":{"enforce":true,"allowlist":["203.0.113.0/24"]},
         "invites":{"policy":"approval","guestsExempt":true},"canEdit":false}
        """)
        XCTAssertEqual(g.retention.publicDays, 365)
        XCTAssertNil(g.retention.privateDays)
        XCTAssertEqual(g.network.allowlist, ["203.0.113.0/24"])
        XCTAssertEqual(g.invites.policy, "approval")

        let hold = try decode(AdminService.Hold.self, """
        {"id":"h1","kind":"person","reason":"Matter 12","createdAt":"2026-09-26T00:00:00Z","releasedAt":null,"target":{"ref":"m1","name":"Aya"}}
        """)
        XCTAssertEqual(hold.target.name, "Aya")
        let channelHold = try decode(AdminService.Hold.self, """
        {"id":"h2","kind":"channel","reason":"Audit","createdAt":"2026-09-26T00:00:00Z","releasedAt":"2026-09-27T00:00:00Z","target":{"channel":"b:cafe"}}
        """)
        XCTAssertEqual(channelHold.target.channel, "b:cafe")
        XCTAssertNotNil(channelHold.releasedAt)
    }

    func testSignOnAndStreamsDecode() throws {
        let sso = try decode(AdminService.SSO.self, """
        {"connections":[{"id":"c1","name":"Okta","provider":"okta","issuer":"https://acme.okta.com","clientId":"x","clientSecret":"set",
          "ssoUrl":null,"certificate":null,"allowedDomains":["acme.co.jp"],"hostedDomain":null,"tenantId":null,"sessionHours":24,
          "status":"active","testedAt":"2026-09-26T00:00:00Z","test":null,"logoutUrl":"https://api.example.com/sso/oidc/c1/backchannel-logout"}],
         "enforce":true,"sso":null}
        """)
        XCTAssertTrue(sso.enforce)
        XCTAssertEqual(sso.connections.first?.logoutUrl, "https://api.example.com/sso/oidc/c1/backchannel-logout")
        let stream = try decode(AdminService.Stream.self, """
        {"id":"s1","kind":"splunk_hec","endpoint":"https://splunk.example.com","region":null,"minSeverity":"info","categories":null,
         "deliveredSeq":10,"status":"active","failures":0,"nextTryAt":null,"lastError":null,"lastSentAt":"2026-09-26T00:00:00Z","createdAt":"2026-09-26T00:00:00Z","behind":0}
        """)
        XCTAssertEqual(stream.kind, "splunk_hec")
    }

    func testDaysReadAsAPersonSaysThem() {
        XCTAssertEqual(AdminService.days(nil), String(localized: "Forever"))
        XCTAssertEqual(AdminService.days(1), String(localized: "1 day"))
        XCTAssertEqual(AdminService.days(365), String(localized: "1 year"))
        XCTAssertEqual(AdminService.days(730), String(localized: "\(2) years"))
        XCTAssertEqual(AdminService.days(90), String(localized: "\(90) days"))
    }
}
