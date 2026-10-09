import XCTest
@testable import TikTokForWork

/// The chat tab's pure parts: what /schedule understands, how Slack's marks
/// and @names are read, and the Worker's message decoded as the list reads it.
final class ChatTests: XCTestCase {
    func testScheduleUnderstandsMinutesHoursAndDays() throws {
        let inHalf = try XCTUnwrap(ChatTimes.parseSchedule("30m call the bank"))
        XCTAssertEqual(inHalf.text, "call the bank")
        XCTAssertEqual(inHalf.at.timeIntervalSinceNow, 1800, accuracy: 5)
        let inTwo = try XCTUnwrap(ChatTimes.parseSchedule("2h ship it"))
        XCTAssertEqual(inTwo.at.timeIntervalSinceNow, 7200, accuracy: 5)
        let tomorrow = try XCTUnwrap(ChatTimes.parseSchedule("tomorrow standup notes"))
        XCTAssertEqual(Calendar.current.component(.hour, from: tomorrow.at), 9)
        XCTAssertTrue(Calendar.current.isDateInTomorrow(tomorrow.at))
        let monday = try XCTUnwrap(ChatTimes.parseSchedule("monday plan the week"))
        XCTAssertEqual(Calendar.current.component(.weekday, from: monday.at), 2)
        XCTAssertGreaterThan(monday.at, .now)
    }

    func testScheduleRefusesWhatItCannotRead() {
        XCTAssertNil(ChatTimes.parseSchedule("soon do it"))
        XCTAssertNil(ChatTimes.parseSchedule("30m"))
        XCTAssertNil(ChatTimes.parseSchedule("0h nothing"))
    }

    func testSlackMarksBecomeFormatting() {
        let text = ChatText.attributed("*bold* and _soft_ for @toru")
        XCTAssertEqual(String(text.characters), "bold and soft for @toru")
        let bold = text.runs.first { run in run.inlinePresentationIntent?.contains(.stronglyEmphasized) == true }
        XCTAssertEqual(bold.map { String(text[$0.range].characters) }, "bold")
    }

    func testMessageDecodesAsTheWorkerSendsIt() throws {
        let json = """
        {"id":"m1","channel":"b:shop","kind":"human","body":"hi","authorName":"Sarah","authorRef":"r1","mine":false,
         "createdAt":"2026-09-24T09:00:00.000Z","replyCount":2,"replyRefs":["r1"],"pinned":true,
         "reactions":[{"emoji":"✅","count":1,"refs":["r2"],"mine":true}]}
        """.data(using: .utf8)!
        let m = try JSONDecoder().decode(ChatMessage.self, from: json)
        XCTAssertEqual(m.channel, "b:shop")
        XCTAssertEqual(m.reactions?.first?.mine, true)
        XCTAssertFalse(m.isAI)
        XCTAssertFalse(m.isDeleted)
        XCTAssertEqual(m.date, ChatDates.parse("2026-09-24T09:00:00.000Z"))
    }

    func testFilesGroupsPrivateChannelsAndEmojiDecode() throws {
        let message = """
        {"id":"m2","channel":"g:0123456789abcdef","kind":"message","body":"","mine":true,"createdAt":"2026-09-26T01:00:00.000Z",
         "files":[{"id":"f_1","name":"menu.png","type":"image/png","size":2048,"width":400,"height":250,"url":"/files/f_1?e=1&s=ab"}]}
        """.data(using: .utf8)!
        let m = try JSONDecoder().decode(ChatMessage.self, from: message)
        let file = try XCTUnwrap(m.files?.first)
        XCTAssertTrue(file.isPicture)
        XCTAssertEqual(file.address(base: URL(string: "https://api.example.com")!)?.absoluteString, "https://api.example.com/files/f_1?e=1&s=ab")

        let business = try JSONDecoder().decode(ChatBusiness.self, from: #"{"slug":"payroll","name":"Payroll","private":true}"#.data(using: .utf8)!)
        XCTAssertEqual(business.isPrivate, true)
        let open = try JSONDecoder().decode(ChatBusiness.self, from: #"{"slug":"cafe","name":"Cafe"}"#.data(using: .utf8)!)
        XCTAssertNil(open.isPrivate)

        let overview = try JSONDecoder().decode(ChatOverview.self, from: #"{"activity":[],"members":[],"groups":[{"view":"g:0123456789abcdef","refs":["r1","r2"]}]}"#.data(using: .utf8)!)
        XCTAssertEqual(overview.groups?.first?.refs, ["r1", "r2"])

        let assets = ChatAssets(emoji: [ChatEmoji(name: "shogun_party", url: "https://api.example.com/emoji/img/emoji-1")], base: nil)
        XCTAssertNotNil(assets.emojiURL(":shogun_party:"))
        XCTAssertNil(assets.emojiURL(":other:"))
        XCTAssertNil(assets.emojiURL("👍"))
    }

    func testJamOpensTheWebAppOnTheConversationsJam() {
        let web = URL(string: "https://app.example.com")!
        XCTAssertEqual(ChatJamLink.jamURL(web: web, view: "b:kitchen")?.absoluteString, "https://app.example.com/#/jam/b:kitchen")
        XCTAssertEqual(ChatJamLink.jamURL(web: web, view: "g:0123456789abcdef")?.absoluteString, "https://app.example.com/#/jam/g:0123456789abcdef")
    }

    func testAnInvitationLinkOrItsCodeJoinsTheSameWorkspace() {
        XCTAssertEqual(WorkspaceDirectory.inviteCode(from: "https://app.example.com/#/join/0123abcd4567ef89"), "0123abcd4567ef89")
        XCTAssertEqual(WorkspaceDirectory.inviteCode(from: "  0123abcd4567ef89 "), "0123abcd4567ef89")
        let entry = try? JSONDecoder().decode(WorkspaceEntry.self, from: #"{"id":"personal:x","name":"ShogunAI","role":"admin","memberCount":7}"#.data(using: .utf8)!)
        XCTAssertEqual(entry?.label, "ShogunAI")
        XCTAssertEqual(entry?.memberCount, 7)
    }

    func testThreadsGroupsAndTheSidebarDecodeAsTheWorkerSendsThem() throws {
        let threads = try JSONDecoder().decode([ChatThreadItem].self, from: #"[{"parent":{"id":"p1","channel":"b:cafe","kind":"message","body":"New beans?","mine":true,"createdAt":"2026-09-26T01:00:00.000Z"},"replies":[{"id":"r1","channel":"b:cafe","kind":"message","body":"Ethiopian","mine":false,"createdAt":"2026-09-26T01:05:00.000Z","parentId":"p1"}],"replyCount":3,"lastReplyAt":"2026-09-26T01:05:00.000Z","unread":true}]"#.data(using: .utf8)!)
        XCTAssertEqual(threads.first?.id, "p1")
        XCTAssertEqual(threads.first?.replyCount, 3)
        XCTAssertTrue(threads.first?.unread == true)
        let groups = try JSONDecoder().decode([ChatUserGroup].self, from: #"[{"handle":"営業","name":"Sales","refs":["r1","r2"],"createdBy":null}]"#.data(using: .utf8)!)
        XCTAssertEqual(groups.first?.handle, "営業")
        let sidebar = try JSONDecoder().decode(ChatSidebar.self, from: #"{"starred":["b:cafe"],"sections":[{"id":"s1","name":"Clients","views":["dm:r1"],"collapsed":false}]}"#.data(using: .utf8)!)
        XCTAssertEqual(sidebar.starred, ["b:cafe"])
        XCTAssertEqual(sidebar.sections.first?.views, ["dm:r1"])
    }

    func testSessionsBookmarksAndKeywordActivityDecodeAsTheWorkerSendsThem() throws {
        let sessions = try JSONDecoder().decode([SignedInSession].self, from: #"[{"ref":"a1b2c3d4e5f60718","client":"ios","device":"iPhone app","place":"Tokyo, JP","createdAt":"2026-09-26T01:00:00.000Z","lastSeenAt":"2026-09-26T02:00:00.000Z","current":true},{"ref":"ffeeddccbbaa0099","client":"web","device":"Chrome on macOS","place":null,"createdAt":"2026-09-20T01:00:00.000Z","lastSeenAt":"2026-09-25T09:00:00.000Z","current":false}]"#.data(using: .utf8)!)
        XCTAssertEqual(sessions.count, 2)
        XCTAssertTrue(sessions[0].current)
        XCTAssertNil(sessions[1].place)
        let bookmarks = try JSONDecoder().decode([ChatBookmark].self, from: #"[{"id":"bm_1","title":"Menu","url":"https://docs.example.com/menu","addedBy":"Mika","mine":false,"createdAt":"2026-09-26T01:00:00.000Z"}]"#.data(using: .utf8)!)
        XCTAssertEqual(bookmarks.first?.title, "Menu")
        let item = try JSONDecoder().decode(ChatActivityItem.self, from: #"{"type":"keyword","keyword":"invoice","unread":true,"message":{"id":"m1","channel":"b:cafe","kind":"message","body":"The invoice is late","mine":false,"createdAt":"2026-09-26T01:00:00.000Z"}}"#.data(using: .utf8)!)
        XCTAssertEqual(item.keyword, "invoice")
        XCTAssertEqual(item.type, "keyword")
        // The server's name for it is what every device marks as seen.
        let keyed = try JSONDecoder().decode(ChatActivityItem.self, from: Data(#"{"key":"r:m1:abc","type":"reaction","emoji":"👍","at":"2026-09-26T02:00:00Z","unread":true,"message":{"id":"m1","channel":"b:cafe","kind":"message","body":"hi","mine":true,"createdAt":"2026-09-26T01:00:00.000Z"}}"#.utf8))
        XCTAssertEqual(keyed.id, "r:m1:abc")
        XCTAssertNotEqual(item.id, keyed.id)
    }

    func testMessagesAndMembersCarryTheirPhotos() throws {
        let member = try JSONDecoder().decode(ChatMember.self, from: Data(#"{"ref":"r1","name":"Gota","title":"member","mine":false,"loginHash":null,"handle":null,"status":null,"awayUntil":null,"avatarUrl":"https://api.test/users/avatar/a1"}"#.utf8))
        XCTAssertEqual(member.avatarUrl, "https://api.test/users/avatar/a1")
        let bare = try JSONDecoder().decode(ChatMember.self, from: Data(#"{"ref":"r2","name":"Aya","title":"member","mine":true}"#.utf8))
        XCTAssertNil(bare.avatarUrl)
        let theirs = try JSONDecoder().decode(ChatMessage.self, from: Data(#"{"id":"m1","channel":"b:x","kind":"message","body":"hi","authorName":"Gota","authorRef":"r1","mine":false,"createdAt":"2026-09-26T10:00:00Z"}"#.utf8))
        let mine = try JSONDecoder().decode(ChatMessage.self, from: Data(#"{"id":"m2","channel":"b:x","kind":"message","body":"yo","mine":true,"createdAt":"2026-09-26T10:01:00Z","authorAvatar":"https://api.test/users/avatar/me"}"#.utf8))
        let assets = ChatAssets(avatars: ["r1": "https://api.test/users/avatar/a1"], myAvatar: "https://api.test/users/avatar/old", myName: "Toru")
        // Someone else's: by their ref. Yours: what the message says first.
        XCTAssertEqual(assets.avatar(of: theirs), "https://api.test/users/avatar/a1")
        XCTAssertEqual(assets.avatar(of: mine), "https://api.test/users/avatar/me")
    }

    @MainActor
    func testSSOOfferAndHandoffAreReadAsTheWorkerSendsThem() throws {
        let offer = SSOService.decodeOffer(Data(#"{"sso":{"orgId":"team:acme","provider":"okta","providerName":"Okta","name":"Acme","enforced":true}}"#.utf8))
        XCTAssertEqual(offer, SSOService.Offer(orgId: "team:acme", providerName: "Okta", workspaceName: "Acme", enforced: true))
        XCTAssertNil(SSOService.decodeOffer(Data("{}".utf8)))
        // A workspace with several providers says which one covers the address.
        let many = SSOService.decodeOffer(Data(#"{"sso":{"orgId":"team:acme","connectionId":"c-kobe","provider":"saml","providerName":"Kobe","name":"Acme","enforced":false}}"#.utf8))
        XCTAssertEqual(many?.connectionId, "c-kobe")
        XCTAssertEqual(try SSOService.handoff(from: URL(string: "tiktokforwork://sso?code=abc123")!), "abc123")
        XCTAssertThrowsError(try SSOService.handoff(from: URL(string: "tiktokforwork://sso?error=Nope")!))
    }

    func testOnlyTheWorkspaceRulesCountAsASessionPolicySignOut() {
        let ended = Data(#"{"message":"This workspace asks you to sign in again.","code":"session-policy","orgId":"team:x"}"#.utf8)
        XCTAssertTrue(SessionPolicy.noticeIfEnded(status: 401, data: ended))
        XCTAssertFalse(SessionPolicy.noticeIfEnded(status: 403, data: ended))
        XCTAssertFalse(SessionPolicy.noticeIfEnded(status: 401, data: Data(#"{"message":"invalid session"}"#.utf8)))
        XCTAssertFalse(SessionPolicy.noticeIfEnded(status: 401, data: Data(#"{"code":"reauth-required"}"#.utf8)))
    }

    /// A reply looked at in Activity reads its thread up to it: a thread
    /// whose newest reply is no later is no longer new; a later one still is.
    func testActivityReadsThreadsUpToTheReplyLookedAt() throws {
        let read = try JSONDecoder().decode([ChatService.ThreadRead].self, from: Data(#"[{"thread":"p1","lastReadAt":"2026-09-28T10:00:00.000Z"},{"thread":"p2","lastReadAt":"2026-09-28T10:00:00.000Z"}]"#.utf8))
        func thread(_ id: String, last: String) throws -> ChatThreadItem {
            try JSONDecoder().decode(ChatThreadItem.self, from: Data("""
            {"parent":{"id":"\(id)","channel":"b:cafe","kind":"message","body":"q","mine":true,"createdAt":"2026-09-28T09:00:00.000Z"},
             "replies":[],"replyCount":1,"lastReplyAt":"\(last)","unread":true}
            """.utf8))
        }
        let out = ChatStore.readThrough([
            try thread("p1", last: "2026-09-28T10:00:00.000Z"),
            try thread("p2", last: "2026-09-28T10:05:00.000Z"),
            try thread("p3", last: "2026-09-28T09:30:00.000Z"),
        ], read)
        XCTAssertEqual(out.map(\.unread), [false, true, true])
    }

    /// Activity keys name messages (`m:`) or reactions (`r:`); only the
    /// messages have notifications of their own to take down.
    func testOnlyMessageKeysNameNotificationsToTakeDown() {
        XCTAssertEqual(ChatStore.messageIds(["m:abc", "r:abc:1x", "m:def", "local-1"]), ["abc", "def"])
    }

    func testTheCanvasDecodesAsTheWorkerSendsIt() throws {
        let canvas = try JSONDecoder().decode(ChatCanvas.self, from: ###"{"body":"## Opening\n- [ ] Unlock at 7","version":3,"updatedBy":"Mika","updatedAt":"2026-09-26T01:00:00.000Z"}"###.data(using: .utf8)!)
        XCTAssertEqual(canvas.version, 3)
        XCTAssertEqual(canvas.updatedBy, "Mika")
        let empty = try JSONDecoder().decode(ChatCanvas.self, from: #"{"body":"","version":0,"updatedBy":null,"updatedAt":null}"#.data(using: .utf8)!)
        XCTAssertEqual(empty.version, 0)
        let revisions = try JSONDecoder().decode([ChatCanvasRevision].self, from: #"[{"version":2,"updatedBy":"Toru","updatedAt":"2026-09-26T01:00:00.000Z","size":12}]"#.data(using: .utf8)!)
        XCTAssertEqual(revisions.first?.id, 2)
    }
}

/// Only an @name that reaches somebody is drawn as a mention.
final class ChatMentionTests: XCTestCase {
    func testTheDirectoryKnowsPeopleGroupsAgentsAndTheAI() throws {
        let members = try JSONDecoder().decode([ChatMember].self, from: Data(#"[{"ref":"m1","name":"Mika Sato","mine":false,"handle":"mika"}]"#.utf8))
        let directory = ChatMentionDirectory()
        directory.update(members: members, groups: [ChatUserGroup(handle: "sales", name: "Sales", refs: [])], agents: [])
        XCTAssertEqual(directory.kind(of: "@mika"), .person)
        XCTAssertEqual(directory.kind(of: "@Mika"), .person)
        XCTAssertEqual(directory.kind(of: "＠sales"), .group)
        XCTAssertEqual(directory.kind(of: "@AI"), .ai)
        XCTAssertNil(directory.kind(of: "@nobody"))
        // How "@" writes a name with a space: run together.
        XCTAssertEqual(directory.kind(of: "@MikaSato"), .person)
        XCTAssertEqual(ChatMentionDirectory.runTogether("佐藤　健二"), "佐藤健二")
        XCTAssertEqual(directory.kind(of: "＠all"), .group)
        XCTAssertEqual(directory.kind(of: "@allの皆さん"), .group)
        XCTAssertEqual(directory.kind(of: "@everyone"), .group)
        XCTAssertNil(directory.kind(of: "@alliance"))
    }

    func testTheComposerChecksOnlyFinishedMentions() {
        XCTAssertEqual(ConversationView.mentionTokens(in: "@mika ask @nobody about it"), ["@mika", "@nobody"])
        XCTAssertEqual(ConversationView.mentionTokens(in: "hi @mik"), [])
        XCTAssertEqual(ConversationView.mentionTokens(in: "mail a@b.com "), [])
        // Names are offered after "＠" and right after Japanese, never inside an address or a link.
        XCTAssertEqual(ConversationView.mentionQuery(in: "確認@mi")?.query, "mi")
        XCTAssertEqual(ConversationView.mentionQuery(in: "確認@mi")?.before, "確認")
        XCTAssertEqual(ConversationView.mentionQuery(in: "＠al")?.query, "al")
        XCTAssertEqual(ConversationView.mentionQuery(in: "hi @")?.query, "")
        XCTAssertNil(ConversationView.mentionQuery(in: "mail a@b"))
        XCTAssertNil(ConversationView.mentionQuery(in: "youtube.com/@ch"))
        XCTAssertNil(ConversationView.mentionQuery(in: "@mika done"))
    }
}

final class ChannelAgentTests: XCTestCase {
    func testTheAgentsInAChannelAndTheOnesToAddDecode() throws {
        let json = """
        {"members":{"people":[],"agents":[
          {"name":"Your AI","kind":"ai","owner":null},
          {"kind":"custom","id":"a1","handle":"menu","name":"Menu","emoji":"📋","description":"","owner":"Mika","canRemove":true},
          {"name":"CI bot","kind":"agent","owner":"Toru"}]},
         "addableAgents":[{"id":"a2","handle":"hayao","name":"Hayao","emoji":null,"scope":"team"}]}
        """
        let got = try JSONDecoder().decode(ChatService.ChannelAgents.self, from: Data(json.utf8))
        XCTAssertEqual(got.placed.map(\.handle), ["menu"])
        XCTAssertEqual(got.placed.first?.glyph, "📋")
        XCTAssertEqual(got.addableAgents?.map(\.handle), ["hayao"])
        XCTAssertEqual(got.addableAgents?.first?.glyph, "🤖")
    }

    func testAnAgentAddedToChannelsSaysWhere() throws {
        let json = #"{"id":"a1","handle":"menu","name":"Menu","emoji":null,"description":"","scope":"personal","channels":["b:cafe"],"placed":true}"#
        let agent = try JSONDecoder().decode(ChatAgent.self, from: Data(json.utf8))
        XCTAssertEqual(agent.channels, ["b:cafe"])
        XCTAssertEqual(agent.placed, true)
        let older = try JSONDecoder().decode(ChatAgent.self, from: Data(#"{"id":"a2","handle":"x","name":"X"}"#.utf8))
        XCTAssertNil(older.channels)
    }
}

final class ChannelRecordTests: XCTestCase {
    func testAChannelsRecordDecodesWithItsContext() throws {
        let json = """
        {"orgId":"o","channel":"research","businesses":[{"slug":"research","name":"Research",
          "decided":[{"id":"c1","title":"Switch supplier","actionLabel":"承認","actor":"Mika","decidedAt":"2026-09-02T10:00:00Z","note":"cheaper"}],
          "open":[{"id":"c2","title":"YCS26 research","recipient":"Gota","createdAt":"2026-09-26T00:00:00Z"}]}],
         "context":"## 目的\\n- 調査","contextAt":"2026-09-26T10:00:00Z","contextNote":null}
        """
        let r = try JSONDecoder().decode(ChatService.ChannelRecord.self, from: Data(json.utf8))
        XCTAssertEqual(r.section?.decided.first?.actor, "Mika")
        XCTAssertEqual(r.section?.open.first?.recipient, "Gota")
        XCTAssertEqual(r.context, "## 目的\n- 調査")
    }

    func testAnAgentCalledInATextIsFound() throws {
        let agent = try JSONDecoder().decode(ChatAgent.self, from: Data(#"{"id":"a1","handle":"hayao","name":"Hayao"}"#.utf8))
        ChatMentionDirectory.shared.update(members: [], groups: [], agents: [agent])
        XCTAssertEqual(ChatMentionDirectory.shared.agentCalled(in: "@hayao YCS26を調べて")?.id, "a1")
        XCTAssertEqual(ChatMentionDirectory.shared.agentCalled(in: "＠hayaoに頼む")?.id, "a1")
        XCTAssertNil(ChatMentionDirectory.shared.agentCalled(in: "@gota 見て"))
    }
}

final class ChatTranslationTests: XCTestCase {
    func testOnlyMessagesInAnotherLanguageAreAskedForOnceAndAnEditAsksAgain() throws {
        let t = ChatTranslations()
        func msg(_ id: String, _ body: String, _ lang: String?) throws -> ChatMessage {
            let json: [String: Any] = ["id": id, "channel": "b:cafe", "kind": "message", "body": body, "mine": false, "createdAt": "2026-09-27T00:00:00Z", "lang": lang as Any]
            return try JSONDecoder().decode(ChatMessage.self, from: JSONSerialization.data(withJSONObject: json.compactMapValues { $0 is NSNull ? nil : $0 }))
        }
        let en = try msg("a", "The menu starts Monday", "en")
        let ja = try msg("b", "月曜から始まります", "ja")
        XCTAssertEqual(t.wanted([en, ja], reader: "ja").map(\.id), ["a"])
        XCTAssertTrue(t.wanted([en], reader: "ja").isEmpty)
        t.store("a", from: en.body, text: "メニューは月曜から")
        XCTAssertEqual(t.shown(en).text, "メニューは月曜から")
        t.toggle("a")
        XCTAssertEqual(t.shown(en).text, "The menu starts Monday")
        let edited = try msg("a", "The menu starts Tuesday", "en")
        XCTAssertFalse(t.hasTranslation(edited))
        XCTAssertEqual(t.wanted([edited], reader: "ja").map(\.id), ["a"])
    }

    func testAKnownTranslationSurvivesAFailedRequestAndARelaunch() throws {
        func msg(_ id: String, _ body: String, _ lang: String?) throws -> ChatMessage {
            let json: [String: Any] = ["id": id, "channel": "b:cafe", "kind": "message", "body": body, "mine": false, "createdAt": "2026-09-27T00:00:00Z", "lang": lang as Any]
            return try JSONDecoder().decode(ChatMessage.self, from: JSONSerialization.data(withJSONObject: json.compactMapValues { $0 is NSNull ? nil : $0 }))
        }
        let ja = try msg("m1", "秋メニューは1日から", "ja")
        let t = ChatTranslations()
        XCTAssertEqual(t.wanted([ja], reader: "en").map(\.id), ["m1"])
        t.store("m1", from: ja.body, text: "Autumn menu from the 1st")
        // A later request that fails does not turn it back into the original.
        t.asking([ja])
        t.answered([ja], error: .offline)
        XCTAssertNil(t.failure(ja))
        XCTAssertEqual(t.shown(ja).text, "Autumn menu from the 1st")
        // Read in another language: not this one, and asked for again.
        XCTAssertEqual(t.wanted([ja], reader: "fr").map(\.id), ["m1"])
        XCTAssertFalse(t.hasTranslation(ja))
        XCTAssertEqual(t.wanted([ja], reader: "en").map(\.id), [])
        XCTAssertTrue(t.hasTranslation(ja))
    }

    func testAFailureSaysWhyAndNoTranslatorIsNoFailure() throws {
        let json: [String: Any] = ["id": "m2", "channel": "b:cafe", "kind": "message", "body": "月曜から", "mine": false, "createdAt": "2026-09-27T00:00:00Z", "lang": "ja"]
        let m = try JSONDecoder().decode(ChatMessage.self, from: JSONSerialization.data(withJSONObject: json))
        let t = ChatTranslations()
        _ = t.wanted([m], reader: "en")
        t.asking([m]); t.answered([m], error: nil, reasons: ["m2": "no_provider"])
        XCTAssertNil(t.failure(m))
        t.asking([m]); t.answered([m], error: nil, reasons: ["m2": "quota"])
        XCTAssertEqual(t.failure(m), .quota)
        t.asking([m]); t.answered([m], error: nil, reasons: ["m2": "provider"])
        XCTAssertEqual(t.failure(m), .provider)
        t.asking([m]); t.answered([m], error: ChatTranslateFailure.of(ChatService.Failure.server(429, nil)))
        XCTAssertEqual(t.failure(m), .rateLimit)
        XCTAssertEqual(ChatTranslateFailure.of(ChatService.Failure.notSignedIn), .auth)
        XCTAssertEqual(ChatTranslateFailure.of(URLError(.notConnectedToInternet)), .offline)
        XCTAssertEqual(ChatTranslateFailure.of(ChatService.Failure.server(502, nil)), .server)
        // Failed, it may be asked for again.
        XCTAssertEqual(t.wanted([m], reader: "en").map(\.id), ["m2"])
    }

    func testFormatMarksToggleSwapAndContinue() {
        XCTAssertEqual(ChatFormat.toggleLine("hello", mark: "> "), "> hello")
        XCTAssertEqual(ChatFormat.toggleLine("> hello", mark: "> "), "hello")
        XCTAssertEqual(ChatFormat.toggleLine("> hello", mark: "- "), "- hello")
        XCTAssertEqual(ChatFormat.toggleLine("a\n3. b", mark: "1. "), "a\nb")
        XCTAssertEqual(ChatFormat.wrapLast("make this bold", "*"), "make this *bold*")
        XCTAssertEqual(ChatFormat.wrapLast("", "_"), "__")
        XCTAssertEqual(ChatFormat.continued(old: "- milk", new: "- milk\n"), "- milk\n- ")
        XCTAssertEqual(ChatFormat.continued(old: "1. a", new: "1. a\n"), "1. a\n2. ")
        XCTAssertEqual(ChatFormat.continued(old: "- milk\n- ", new: "- milk\n- \n"), "- milk\n")
        XCTAssertNil(ChatFormat.continued(old: "hello", new: "hello\n"))
        XCTAssertEqual(ChatRichText.numbered("12. twelve")?.n, 12)
        XCTAssertNil(ChatRichText.numbered("1.5 million"))
    }

    func testAMessageLinkIsTheWebsOwnWithItsWorkspace() {
        let web = URL(string: "https://app.example.com")!
        XCTAssertEqual(ChatStore.messageLink(web: web, messageId: "m-1", orgId: "personal:abc")?.absoluteString, "https://app.example.com/#/m/m-1/personal%3Aabc")
        XCTAssertEqual(ChatStore.messageLink(web: web, messageId: "m-1", orgId: nil)?.absoluteString, "https://app.example.com/#/m/m-1")
        // A conversation's link, the same the web's "Copy link" makes.
        XCTAssertEqual(ChatStore.conversationLink(web: web, view: "b:front-desk")?.absoluteString, "https://app.example.com/#/c/b%3Afront-desk")
        XCTAssertEqual(ChatStore.conversationLink(web: web, view: "b:日報")?.absoluteString, "https://app.example.com/#/c/b%3A%E6%97%A5%E5%A0%B1")
    }

    func testChannelsFollowTheOrderDraggedOnTheWebAndTheRestKeepTheirs() {
        let c = { (v: String) in ChatConversation(kind: .channel, view: v, name: v, member: nil) }
        let out = ChatConversation.inOrder([c("b:a"), c("b:b"), c("b:c"), c("b:d")], ["b:c", "b:a"])
        XCTAssertEqual(out.map(\.view), ["b:c", "b:a", "b:b", "b:d"])
    }

    /// An inline reply (#237): the quote the Worker hands out with it, and
    /// the one drawn under a reply on its way, before the server has it.
    func testAnInlineReplyDecodesItsQuoteAndQuotesAMessageAsTheWorkerDoes() throws {
        let reply = try JSONDecoder().decode(ChatMessage.self, from: #"{"id":"m2","channel":"b:cafe","kind":"message","body":"Yes, Kyoto","mine":false,"createdAt":"2026-10-09T01:05:00.000Z","replyTo":{"id":"m1","kind":"message","authorName":"Mika","authorRef":"r1","excerpt":"Which supplier?","deleted":false}}"#.data(using: .utf8)!)
        XCTAssertEqual(reply.replyTo?.id, "m1")
        XCTAssertEqual(reply.replyTo?.authorName, "Mika")
        XCTAssertEqual(reply.replyTo?.excerpt, "Which supplier?")
        let gone = try JSONDecoder().decode(ChatMessage.self, from: #"{"id":"m3","channel":"b:cafe","kind":"message","body":"ok","mine":true,"createdAt":"2026-10-09T01:06:00.000Z","replyTo":{"id":"m1","kind":null,"authorName":null,"authorRef":null,"excerpt":"","deleted":true}}"#.data(using: .utf8)!)
        XCTAssertEqual(gone.replyTo?.deleted, true)

        let said = ChatMessage(id: "m1", channel: "b:cafe", kind: "message", body: "Which   supplier\nfor the beans?", authorName: "Mika", authorRef: "r1", mine: false, createdAt: "2026-10-09T01:00:00.000Z")
        let quote = ChatQuote(of: said)
        XCTAssertEqual(quote.id, "m1")
        XCTAssertEqual(quote.excerpt, "Which supplier for the beans?")
        XCTAssertEqual(quote.authorName, "Mika")
        XCTAssertFalse(quote.deleted)
        let long = ChatQuote(of: ChatMessage(id: "m4", channel: "b:cafe", kind: "message", body: String(repeating: "a", count: 300), mine: true, createdAt: "2026-10-09T01:00:00.000Z"))
        XCTAssertEqual(long.excerpt.count, 120)
        XCTAssertTrue(long.excerpt.hasSuffix("…"))
        let ai = ChatQuote(of: ChatMessage(id: "m5", channel: "b:cafe", kind: "ai", body: "Done.", authorName: "AI", mine: false, createdAt: "2026-10-09T01:00:00.000Z"))
        XCTAssertNil(ai.authorName)
        XCTAssertEqual(ai.kind, "ai")
        var unsent = said
        unsent.deleted = true
        XCTAssertTrue(ChatQuote(of: unsent).deleted)
    }
}
