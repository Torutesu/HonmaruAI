import XCTest
@testable import TikTokForWork

/// The team's agents as the Worker sends them: the list on the Agents
/// screen, the overview's short form, and a message an agent wrote.
final class AgentTests: XCTestCase {
    func testClientAgentDecodesAsTheWorkerSendsIt() throws {
        let json = """
        {"id":"a1","handle":"hayao","name":"Hayao","emoji":"🎨","description":"Art direction for launches.",
         "instructions":"# Hayao\\n\\nYou review visuals.","scope":"team","preset":null,
         "createdBy":"r1","createdByName":"Sarah","mine":false,"updatedByName":"Toru",
         "updatedAt":"2026-09-24T09:00:00.000Z","canEdit":true,"canDelete":false,
         "markdown":"---\\nname: Hayao\\nhandle: hayao\\n---\\n\\n# Hayao\\n"}
        """.data(using: .utf8)!
        let a = try JSONDecoder().decode(ChatAgent.self, from: json)
        XCTAssertEqual(a.handle, "hayao")
        XCTAssertEqual(a.glyph, "🎨")
        XCTAssertFalse(a.isPersonal)
        XCTAssertNil(a.preset)
        XCTAssertEqual(a.canEdit, true)
        XCTAssertEqual(a.canDelete, false)
        XCTAssertEqual(a.createdByName, "Sarah")
        XCTAssertTrue(a.markdown?.hasPrefix("---") == true)

        let draft = AgentDraft(agent: a)
        XCTAssertEqual(draft.agentId, "a1")
        XCTAssertTrue(draft.canEdit)
        XCTAssertFalse(draft.canChangeScope)
        XCTAssertEqual(draft.cleanHandle, "hayao")
    }

    func testAgentsResponseAndOverviewDecode() throws {
        let list = """
        {"agents":[{"id":"a2","handle":"mine","name":"Mine","emoji":null,"description":"","instructions":"x","scope":"personal",
          "mine":true,"updatedAt":"2026-09-24T09:00:00.000Z","canEdit":true,"canDelete":true,"markdown":"x"}],
         "presets":[{"id":"secretary","handle":"secretary","emoji":"🗂️","name":"Secretary","description":"Summaries.","instructions":"# Secretary"}]}
        """.data(using: .utf8)!
        let out = try JSONDecoder().decode(ChatService.Agents.self, from: list)
        XCTAssertEqual(out.agents.first?.isPersonal, true)
        XCTAssertEqual(out.agents.first?.glyph, "🤖")
        XCTAssertEqual(out.presets?.first?.id, "secretary")
        XCTAssertEqual(AgentDraft(preset: try XCTUnwrap(out.presets?.first)).preset, "secretary")

        // An older Worker sends no agents in the overview; it still decodes.
        let old = #"{"activity":[],"members":[]}"#.data(using: .utf8)!
        XCTAssertNil(try JSONDecoder().decode(ChatOverview.self, from: old).agents)
        let new = #"{"activity":[],"members":[],"agents":[{"id":"a1","handle":"hayao","name":"Hayao","emoji":"🎨","description":"","scope":"team"}]}"#.data(using: .utf8)!
        XCTAssertEqual(try JSONDecoder().decode(ChatOverview.self, from: new).agents?.first?.handle, "hayao")
    }

    func testAgentMessageDecodes() throws {
        let json = """
        {"id":"m9","channel":"b:shop","kind":"agent","body":"Here is the plan.","authorName":"Hayao","authorRef":null,"mine":false,
         "createdAt":"2026-09-24T09:01:00.000Z","parentId":"m1","agent":{"id":"a1","handle":"hayao","name":"Hayao","emoji":"🎨"}}
        """.data(using: .utf8)!
        let m = try JSONDecoder().decode(ChatMessage.self, from: json)
        XCTAssertTrue(m.isAgent)
        XCTAssertFalse(m.isAI)
        XCTAssertNil(m.authorRef)
        XCTAssertEqual(m.parentId, "m1")
        XCTAssertEqual(m.agent?.handle, "hayao")
        XCTAssertEqual(m.agent?.glyph, "🎨")
    }

    func testHandleIsMadeFromTheNameWhenLeftEmpty() {
        var d = AgentDraft()
        d.name = "Art Bot"
        XCTAssertEqual(d.cleanHandle, "artbot")
        d.handle = "@Hayao"
        XCTAssertEqual(d.cleanHandle, "hayao")
    }
}
