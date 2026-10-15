import XCTest
@testable import TikTokForWork

/// The harness's answers, decoded the way its screens read them
/// (docs/kylon-gap-plan.md). The JSON is what the Worker sends — the shapes
/// worker/test/harness-*.test.js pin on the other side.
final class HarnessServiceTests: XCTestCase {
    func testAnAppDecodesWithItsRowsAndEveryView() throws {
        let json = """
        {"app":{"id":"app_1","orgId":"o","name":"Sales CRM","description":"Leads to won deals","icon":"💼","tableId":"tbl_1",
                "template":"crm","version":2,"definition":{"views":[]},"createdBy":"1","createdAt":"x","updatedAt":"x","channels":["b:sales"]},
         "table":{"id":"tbl_1","name":"Sales CRM","columns":[
            {"id":"company","name":"Company","type":"text"},
            {"id":"stage","name":"Stage","type":"select","options":["Lead","Won"]},
            {"id":"value","name":"Value","type":"number"},
            {"id":"hot","name":"Hot","type":"checkbox"}]},
         "rows":[{"id":"row_1","tableId":"tbl_1","values":{"company":"Acme","stage":"Lead","value":24000,"hot":true,"close":null},"position":1}],
         "views":[
            {"id":"v1","type":"board","name":"Pipeline","groupBy":"stage","lanes":[{"key":"Lead","rows":[]},{"key":null,"rows":[]}]},
            {"id":"v2","type":"table","name":"All","rows":[]},
            {"id":"v3","type":"metrics","name":"Forecast","values":[{"label":"Open pipeline","op":"sum","column":"value","value":42000},{"label":"Average","op":"avg","value":null}]}]}
        """
        let r = try JSONDecoder().decode(HarnessService.RenderedApp.self, from: Data(json.utf8))
        XCTAssertEqual(r.app.channels, ["b:sales"])
        XCTAssertEqual(r.views.map(\.type), ["board", "table", "metrics"])
        XCTAssertEqual(r.views[0].lanes?.map(\.id), ["Lead", "—"])
        XCTAssertEqual(r.views[2].values?.first?.value, 42000)
        XCTAssertNil(r.views[2].values?.last?.value)

        let row = r.rows[0]
        let columns = r.table.columns
        XCTAssertEqual(row.values["value"], .number(24000))
        XCTAssertEqual(row.values["hot"], .bool(true))
        XCTAssertEqual(row.values["close"], .null)
        XCTAssertEqual(HarnessService.cellText(columns[0], row.values["company"]), "Acme")
        XCTAssertEqual(HarnessService.cellText(columns[3], row.values["hot"]), "✓")
        XCTAssertEqual(HarnessService.cellText(columns[2], nil), "")
    }

    func testAWorkflowAndItsRunsDecodeWhateverElseTheStepsCarry() throws {
        let json = """
        {"workflow":{"id":"wf_1","orgId":"o","name":"Chase overdue invoices","enabled":true,
            "trigger":{"type":"row","tableId":"tbl_1","on":"changed","where":{"status":["Overdue"]}},
            "steps":[{"type":"post","channel":"b:ops","text":"{{row.Client}} is overdue"},{"type":"add_row","tableId":"tbl_1","values":{"client":"x"}}],
            "nextRunAt":null,"lastRunAt":null,"createdBy":"1","createdAt":"x","updatedAt":"x"},
         "runs":[{"id":"run_1","workflowId":"wf_1","trigger":"row","status":"waiting","input":{"row":{"id":"r"}},
            "log":[{"step":1,"type":"post","status":"ok","output":"Acme is overdue","at":"x"},{"step":2,"type":"approval","status":"waiting","cardId":"wf-run_1","at":"x"}],
            "nextStep":2,"cardId":"wf-run_1","startedBy":"1","startedAt":"2026-10-15T09:55:15.000Z","finishedAt":null}],
         "canEdit":true}
        """
        let d = try JSONDecoder().decode(HarnessService.WorkflowDetail.self, from: Data(json.utf8))
        XCTAssertEqual(d.workflow.trigger.type, "row")
        XCTAssertEqual(d.workflow.steps.map(\.type), ["post", "add_row"])
        XCTAssertEqual(d.runs.first?.log.map(\.status), ["ok", "waiting"])
        XCTAssertNotNil(HarnessService.date(d.runs[0].startedAt))
    }

    func testAStepIsSentWithoutItsLocalIdOrEmptyFields() throws {
        let step = HarnessService.Step(type: "post", channel: "b:ops", text: "Weekly check")
        let sent = try JSONSerialization.jsonObject(with: JSONEncoder().encode(step)) as? [String: Any]
        XCTAssertEqual(sent?["type"] as? String, "post")
        XCTAssertEqual(sent?["channel"] as? String, "b:ops")
        XCTAssertNil(sent?["id"])
        XCTAssertNil(sent?["minutes"])
    }

    func testTypedFieldsBecomeTheColumnsValues() {
        let number = HarnessService.Column(id: "amount", name: "Amount", type: "number", options: nil)
        let box = HarnessService.Column(id: "hot", name: "Hot", type: "checkbox", options: nil)
        let text = HarnessService.Column(id: "client", name: "Client", type: "text", options: nil)
        XCTAssertEqual(HarnessService.value(for: number, from: "1,500") as? Double, 1500)
        XCTAssertEqual(HarnessService.value(for: box, from: "yes") as? Bool, true)
        XCTAssertEqual(HarnessService.value(for: text, from: "  Acme ") as? String, "Acme")
        XCTAssertTrue(HarnessService.value(for: text, from: "   ") is NSNull)
    }

    func testARoomIsReadOutOfASentence() {
        XCTAssertEqual(HarnessService.roomIn("An invoice tracker for #ops, please"), "ops")
        XCTAssertEqual(HarnessService.roomIn("採用ボードを #採用 に"), "採用")
        XCTAssertNil(HarnessService.roomIn("No room here"))
    }

    func testTheModesAreTheWorkersWords() throws {
        let state = try JSONDecoder().decode(HarnessService.ModeState.self, from: Data(#"{"orgId":"o","mode":"harness","modes":["simple","harness"],"canEdit":false}"#.utf8))
        XCTAssertEqual(state.mode, .harness)
        XCTAssertFalse(state.canEdit)
    }
}
