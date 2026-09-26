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
    }

    func testTheComposerChecksOnlyFinishedMentions() {
        XCTAssertEqual(ConversationView.mentionTokens(in: "@mika ask @nobody about it"), ["@mika", "@nobody"])
        XCTAssertEqual(ConversationView.mentionTokens(in: "hi @mik"), [])
        XCTAssertEqual(ConversationView.mentionTokens(in: "mail a@b.com "), [])
    }
}
