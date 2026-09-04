import XCTest
@testable import TikTokForWork

/// The wire boundary. Everything the relay says arrives here first, and a shape
/// this misreads is a decision that silently never appears — which is the one
/// failure mode nobody can see from the inside.
///
/// The docs claimed these tests existed for a year before they did.
final class AGUIEventTests: XCTestCase {
    @MainActor
    private func assembler() -> AGUIEventAssembler {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return AGUIEventAssembler(decoder: decoder)
    }

    private func cardJSON(_ id: String, recipient: String = "grace", sender: String = "ada") -> [String: Any] {
        [
            "id": id,
            "recipientUserID": recipient,
            "senderUserID": sender,
            "type": "approval",
            "title": "Approve the budget",
            "summary": "Q3 marketing spend",
            "context": "deadline: Friday",
            "status": "pending",
            "priority": "high",
            "createdAt": "2026-09-01T00:00:00Z",
        ]
    }

    @MainActor
    func testASnapshotGroupsCardsByWhoHasToDecideThem() {
        let events = assembler().handle([
            "type": "STATE_SNAPSHOT",
            "snapshot": ["cardsById": [
                "c-1": cardJSON("c-1"),
                "c-2": cardJSON("c-2", recipient: "ada", sender: "grace"),
            ]],
        ])

        guard case .snapshot(let byUser)? = events.first else {
            return XCTFail("expected a snapshot, got \(events)")
        }
        XCTAssertEqual(byUser["grace"]?.map(\.id), ["c-1"])
        XCTAssertEqual(byUser["ada"]?.map(\.id), ["c-2"])
    }

    @MainActor
    func testASnapshotCarriesTheSharedContextItAlwaysCarried() {
        // The relay has sent this since it was written and the assembler read
        // `cardsById` and dropped the rest — so "mirrored to the relay so it
        // survives a reinstall" was true of the relay and false of the app.
        let events = assembler().handle([
            "type": "STATE_SNAPSHOT",
            "snapshot": [
                "cardsById": [:],
                "context": ["octocat": ["text": "I own billing decisions."]],
            ],
        ])

        let text = events.compactMap { event -> String? in
            if case .context(let userID, let text) = event, userID == "octocat" { return text }
            return nil
        }.first
        XCTAssertEqual(text, "I own billing decisions.")
    }

    @MainActor
    func testPatchesAddReplaceAndRemoveByCardID() {
        let subject = assembler()
        let added = subject.handle([
            "type": "STATE_DELTA",
            "delta": [["op": "add", "path": "/cardsById/c-1", "value": cardJSON("c-1")]],
        ])
        guard case .cardCreated(let card)? = added.first else {
            return XCTFail("expected a created card, got \(added)")
        }
        XCTAssertEqual(card.id, "c-1")

        let replaced = subject.handle([
            "type": "STATE_DELTA",
            "delta": [["op": "replace", "path": "/cardsById/c-1", "value": cardJSON("c-1")]],
        ])
        guard case .cardUpdated? = replaced.first else {
            return XCTFail("expected an updated card, got \(replaced)")
        }

        let removed = subject.handle([
            "type": "STATE_DELTA",
            "delta": [["op": "remove", "path": "/cardsById/c-1"]],
        ])
        guard case .cardDeleted(let id, _)? = removed.first else {
            return XCTFail("expected a deleted card, got \(removed)")
        }
        XCTAssertEqual(id, "c-1")
    }

    @MainActor
    func testAPointerIsUnescapedBeforeItIsUsedAsAnID() {
        // RFC 6901: a card id containing a slash or a tilde is escaped on the
        // wire, and reading it back raw would address a card that is not there.
        XCTAssertEqual(AGUIEventAssembler.cardID(fromPointer: "/cardsById/a~1b~0c"), "a/b~c")
        XCTAssertEqual(AGUIEventAssembler.userID(fromContextPointer: "/context/octocat"), "octocat")
        // A pointer into someone's context is not a card id, and the two live
        // one segment apart.
        XCTAssertNil(AGUIEventAssembler.cardID(fromPointer: "/context/octocat"))
        XCTAssertNil(AGUIEventAssembler.userID(fromContextPointer: "/cardsById/c-1"))
        XCTAssertNil(AGUIEventAssembler.cardID(fromPointer: "/cardsById/"))
    }

    @MainActor
    func testAToolCallIsBufferedUntilItsArgumentsAreWhole() {
        // Args arrive as chunked string deltas. Parsing a chunk on its own is
        // parsing half a JSON document, so nothing is decoded until END.
        let subject = assembler()
        let args = String(
            data: try! JSONSerialization.data(withJSONObject: ["card": cardJSON("c-chunked")]),
            encoding: .utf8
        )!
        let half = args.index(args.startIndex, offsetBy: args.count / 2)

        XCTAssertTrue(subject.handle([
            "type": "TOOL_CALL_START", "toolCallId": "t-1", "toolCallName": "request_decision",
        ]).isEmpty)
        XCTAssertTrue(subject.handle([
            "type": "TOOL_CALL_ARGS", "toolCallId": "t-1", "delta": String(args[..<half]),
        ]).isEmpty)
        XCTAssertTrue(subject.handle([
            "type": "TOOL_CALL_ARGS", "toolCallId": "t-1", "delta": String(args[half...]),
        ]).isEmpty)

        let ended = subject.handle(["type": "TOOL_CALL_END", "toolCallId": "t-1"])
        guard case .cardCreated(let card)? = ended.first else {
            return XCTFail("expected the card the tool call carried, got \(ended)")
        }
        XCTAssertEqual(card.id, "c-chunked")
        // Kept so the answer can name the question that asked for it.
        XCTAssertEqual(subject.toolCallIDsByCard["c-chunked"], "t-1")
    }

    @MainActor
    func testACardWeCannotReadIsSkippedRatherThanTakingTheSnapshotWithIt() {
        let events = assembler().handle([
            "type": "STATE_SNAPSHOT",
            "snapshot": ["cardsById": [
                "c-good": cardJSON("c-good"),
                "c-bad": ["id": "c-bad"],
            ]],
        ])
        guard case .snapshot(let byUser)? = events.first else {
            return XCTFail("expected a snapshot, got \(events)")
        }
        XCTAssertEqual(byUser.values.flatMap { $0 }.map(\.id), ["c-good"])
    }

    // Shared context is the other half of a STATE_DELTA. A patch under
    // /context/<login> is somebody rewriting what their AI knows about them,
    // and reading it as a card patch would have thrown it away.
    @MainActor
    func testAContextPatchIsAContextChangeAndNotACard() {
        let a = assembler()
        let events = a.handle([
            "type": "STATE_DELTA",
            "delta": [["op": "replace", "path": "/context/octocat", "value": ["text": "runs billing"]]],
        ])
        guard case .context(let userID, let text)? = events.first else {
            return XCTFail("expected a context event, got \(events)")
        }
        XCTAssertEqual(userID, "octocat")
        XCTAssertEqual(text, "runs billing")
    }

    // A login with a slash or a tilde in it is escaped on the wire per RFC 6901.
    // Unescaping the card pointer was handled; the context pointer was not.
    @MainActor
    func testAnEscapedContextPointerIsUnescapedToo() {
        let a = assembler()
        let events = a.handle([
            "type": "STATE_DELTA",
            "delta": [["op": "replace", "path": "/context/acme~1team", "value": ["text": "shared"]]],
        ])
        guard case .context(let userID, _)? = events.first else {
            return XCTFail("expected a context event, got \(events)")
        }
        XCTAssertEqual(userID, "acme/team")
    }

    // The relay refuses things — a forged sender, an id already taken, a
    // decision that changed under you. Every one of those arrives here, and a
    // dropped RUN_ERROR is a failure the person never hears about.
    @MainActor
    func testARunErrorBecomesSomethingTheAppCanShow() {
        let a = assembler()
        let events = a.handle(["type": "RUN_ERROR", "message": "A decision with that id already exists."])
        guard case .error(let message)? = events.first else {
            return XCTFail("expected an error event, got \(events)")
        }
        XCTAssertEqual(message, "A decision with that id already exists.")
    }

    // Anything else the relay grows later. Ignoring it is right; crashing or
    // inventing an event is not.
    @MainActor
    func testAnEventThisBuildDoesNotKnowIsIgnored() {
        let a = assembler()
        XCTAssertTrue(a.handle(["type": "SOMETHING_NEW", "payload": ["x": 1]]).isEmpty)
        XCTAssertTrue(a.handle(["nothing": "useful"]).isEmpty)
    }

    // A remove patch carries only the id. The assembler reports that and leaves
    // the recipient blank on purpose — the socket layer tracks who each card
    // belonged to, because it is the thing that saw the snapshot. Filling it in
    // here from a guess would be worse than leaving it to the layer that knows.
    @MainActor
    func testARemoveReportsTheIdAndLeavesTheOwnerToTheSocket() {
        let a = assembler()
        let events = a.handle([
            "type": "STATE_DELTA",
            "delta": [["op": "remove", "path": "/cardsById/c-1"]],
        ])
        guard case .cardDeleted(let cardID, let recipient)? = events.first else {
            return XCTFail("expected a deletion, got \(events)")
        }
        XCTAssertEqual(cardID, "c-1")
        XCTAssertEqual(recipient, "")
    }

    // The value is an object, not a string. Reading it as a string would drop
    // every context change silently.
    @MainActor
    func testAContextPatchWithNoTextIsIgnoredRatherThanReadAsEmpty() {
        let a = assembler()
        XCTAssertTrue(a.handle([
            "type": "STATE_DELTA",
            "delta": [["op": "replace", "path": "/context/octocat", "value": "a bare string"]],
        ]).isEmpty)
    }
}
