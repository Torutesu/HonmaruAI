import XCTest
import UIKit
import AVFoundation
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

    func testThreadTimesCarryTheirDateBeforeToday() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = try XCTUnwrap(TimeZone(identifier: "UTC"))
        let now = try XCTUnwrap(ChatDates.parse("2026-10-01T18:00:00.000Z"))
        let today = try XCTUnwrap(ChatDates.parse("2026-10-01T05:41:00.000Z"))
        let earlier = try XCTUnwrap(ChatDates.parse("2026-09-28T19:28:00.000Z"))
        let lastYear = try XCTUnwrap(ChatDates.parse("2025-12-31T19:28:00.000Z"))
        let timeOnly = Date.FormatStyle.dateTime.hour().minute()
        let dated = Date.FormatStyle.dateTime.month(.abbreviated).day().hour().minute()
        XCTAssertEqual(ChatDates.threadStyle(for: today, now: now, calendar: calendar), timeOnly)
        XCTAssertEqual(ChatDates.threadStyle(for: earlier, now: now, calendar: calendar), dated)
        XCTAssertEqual(ChatDates.threadStyle(for: lastYear, now: now, calendar: calendar), dated.year())
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

    /// A deleted thread's replies sent to the conversation too leave it with
    /// the thread; another thread's stay.
    func testADeletedThreadTakesItsRepliesFromTheConversation() throws {
        func message(_ id: String, parent: String?) throws -> ChatMessage {
            let parentField = parent.map { #","parentId":"\#($0)","alsoChannel":true"# } ?? ""
            return try JSONDecoder().decode(ChatMessage.self, from: Data(#"{"id":"\#(id)","channel":"b:cafe","kind":"message","body":"x","mine":false,"createdAt":"2026-09-28T09:00:00.000Z"\#(parentField)}"#.utf8))
        }
        let list = [try message("p1", parent: nil), try message("r1", parent: "p1"), try message("r2", parent: "p2"), try message("m9", parent: nil)]
        XCTAssertEqual(ChatStore.withoutReplies(of: "p1", in: list).map(\.id), ["p1", "r2", "m9"])
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

    func testPhotosPickedInSeveralGoesNeverAddUpToMoreThanAMessageCarries() {
        XCTAssertEqual(ChatPhotos.maxPerMessage, 10)
        XCTAssertEqual(ChatPhotos.room(attached: 0, uploading: 0), 10)
        // Ten picked: nothing more, whether they have arrived or are still going up.
        XCTAssertEqual(ChatPhotos.room(attached: 10, uploading: 0), 0)
        XCTAssertEqual(ChatPhotos.room(attached: 4, uploading: 6), 0)
        XCTAssertEqual(ChatPhotos.room(attached: 7, uploading: 2), 1)
        // Taking one off gives back exactly one place.
        XCTAssertEqual(ChatPhotos.room(attached: 9, uploading: 0), 1)
        XCTAssertEqual(ChatPhotos.room(attached: 12, uploading: 0), 0)
    }

    func testAPhotoGoesUpNoLargerThanItNeedsToBe() throws {
        // A camera-sized photo: sent at the long side's limit, its shape kept.
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        let big = UIGraphicsImageRenderer(size: CGSize(width: 4000, height: 3000), format: format).image { ctx in
            UIColor.systemTeal.setFill(); ctx.fill(CGRect(x: 0, y: 0, width: 4000, height: 3000))
        }
        let original = try XCTUnwrap(big.jpegData(compressionQuality: 0.95))
        let sent = try XCTUnwrap(ChatPhotos.prepared(original))
        XCTAssertEqual(sent.width, ChatPhotos.maxPixels)
        XCTAssertEqual(sent.height, 1920)
        XCTAssertLessThan(sent.jpeg.count, original.count)
        // One already small enough is not made larger.
        let small = UIGraphicsImageRenderer(size: CGSize(width: 800, height: 600), format: format).image { ctx in
            UIColor.systemPink.setFill(); ctx.fill(CGRect(x: 0, y: 0, width: 800, height: 600))
        }
        let kept = try XCTUnwrap(ChatPhotos.prepared(try XCTUnwrap(small.jpegData(compressionQuality: 0.9))))
        XCTAssertEqual(kept.width, 800)
        XCTAssertEqual(kept.height, 600)
        XCTAssertNil(ChatPhotos.prepared(Data("not a picture".utf8)))
    }

    func testSomeoneWithTheAppOpenIsShownOnline() {
        // The relay names logins; the member list carries the first 16 hex
        // digits of each login's SHA-256.
        let kenji = ChatHash.short("kenji@example.com")
        XCTAssertEqual(kenji.count, 16)
        XCTAssertTrue(ChatHash.online(kenji, among: ["anand@example.com", "kenji@example.com"]))
        XCTAssertFalse(ChatHash.online(kenji, among: ["anand@example.com"]))
        XCTAssertFalse(ChatHash.online(nil, among: ["kenji@example.com"]))
        XCTAssertFalse(ChatHash.online("", among: []))
    }

    func testAnAgentWritingShowsItsOwnPicture() throws {
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(#"""
        {"channel":"c:research","step":"writing","agent":{"id":"ag_1","handle":"hayao","name":"Hayao","emoji":null,"avatarUrl":"/channels/agents/ag_1/avatar?v=2"}}
        """#.utf8)) as? [String: Any])
        let face = try XCTUnwrap(ChatAgentFace.live(try XCTUnwrap(json["agent"] as? [String: Any])))
        XCTAssertEqual(face.id, "ag_1")
        XCTAssertEqual(face.name, "Hayao")
        XCTAssertEqual(face.avatarUrl, "/channels/agents/ag_1/avatar?v=2")
        // One with no picture keeps its emoji, and one with no id is no agent.
        let plain = try XCTUnwrap(ChatAgentFace.live(["id": "ag_2", "handle": "rin", "name": "Rin", "emoji": "🎨"]))
        XCTAssertNil(plain.avatarUrl)
        XCTAssertEqual(plain.glyph, "🎨")
        XCTAssertNil(ChatAgentFace.live(["name": "Nobody"]))
    }

    func testAVideoGoesUpAsAnMp4ThatFits() async throws {
        // A second of 640x360 from the camera roll, as a .mov.
        let source = FileManager.default.temporaryDirectory.appendingPathComponent("clip-\(UUID().uuidString).mov")
        defer { try? FileManager.default.removeItem(at: source) }
        let writer = try AVAssetWriter(outputURL: source, fileType: .mov)
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: 640, AVVideoHeightKey: 360,
        ])
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
            kCVPixelBufferWidthKey as String: 640,
            kCVPixelBufferHeightKey as String: 360,
        ])
        writer.add(input)
        XCTAssertTrue(writer.startWriting())
        writer.startSession(atSourceTime: .zero)
        let pool = try XCTUnwrap(adaptor.pixelBufferPool)
        for frame in 0..<30 {
            while !input.isReadyForMoreMediaData { try await Task.sleep(for: .milliseconds(10)) }
            var buffer: CVPixelBuffer?
            CVPixelBufferPoolCreatePixelBuffer(nil, pool, &buffer)
            let pixels = try XCTUnwrap(buffer)
            XCTAssertTrue(adaptor.append(pixels, withPresentationTime: CMTime(value: CMTimeValue(frame), timescale: 30)))
        }
        input.markAsFinished()
        await writer.finishWriting()
        XCTAssertEqual(writer.status, .completed)

        // Sent as an mp4 under the Worker's limit, at the shape it is seen at.
        let prepared = await ChatPhotos.preparedVideo(source)
        let sent = try XCTUnwrap(prepared)
        XCTAssertEqual(sent.width, 640)
        XCTAssertEqual(sent.height, 360)
        XCTAssertLessThanOrEqual(sent.mp4.count, ChatPhotos.maxBytes)
        XCTAssertEqual(sent.mp4.subdata(in: 4..<8), Data("ftyp".utf8))

        // Something that is not a video is not sent as one.
        let text = FileManager.default.temporaryDirectory.appendingPathComponent("not-\(UUID().uuidString).mov")
        defer { try? FileManager.default.removeItem(at: text) }
        try Data("not a video".utf8).write(to: text)
        let refused = await ChatPhotos.preparedVideo(text)
        XCTAssertNil(refused)
    }

    func testAFailedRenewalIsTriedAgainSoonAndNeverLeftForGood() {
        XCTAssertEqual(ChatMediaURLs.retryDelay(afterFailures: 1), 10)
        XCTAssertEqual(ChatMediaURLs.retryDelay(afterFailures: 2), 20)
        XCTAssertEqual(ChatMediaURLs.retryDelay(afterFailures: 3), 40)
        XCTAssertEqual(ChatMediaURLs.retryDelay(afterFailures: 4), 60)
        XCTAssertEqual(ChatMediaURLs.retryDelay(afterFailures: 50), 60)
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

    /// A slow answer for words since edited does not put out the
    /// translation of the words as they are now (#390).
    func testALateTranslationOfOldWordsKeepsTheNewOne() throws {
        func msg(_ body: String) throws -> ChatMessage {
            let json: [String: Any] = ["id": "m1", "channel": "b:cafe", "kind": "message", "body": body, "mine": false, "createdAt": "2026-09-27T00:00:00Z", "lang": "ja"]
            return try JSONDecoder().decode(ChatMessage.self, from: JSONSerialization.data(withJSONObject: json))
        }
        let a = try msg("秋メニューは1日から")
        let b = try msg("修正：秋メニューは2日から")
        let t = ChatTranslations()
        XCTAssertEqual(t.wanted([a], reader: "en").map(\.id), ["m1"])
        XCTAssertEqual(t.wanted([b], reader: "en").map(\.id), ["m1"])
        t.asking([a]); t.asking([b])
        // B comes back first, then A.
        t.store("m1", from: b.body, text: "Fixed: from the 2nd", lang: "en")
        t.answered([b], error: nil)
        XCTAssertTrue(t.isPending(a))
        t.store("m1", from: a.body, text: "From the 1st", lang: "en")
        t.answered([a], error: nil)
        XCTAssertEqual(t.shown(b).text, "Fixed: from the 2nd")
        XCTAssertNil(t.failure(b))
        // Edited back to A: its translation is there too.
        XCTAssertEqual(t.shown(a).text, "From the 1st")
        XCTAssertNotEqual(ChatTranslations.textKey("m1", lang: "en", from: a.body), ChatTranslations.textKey("m1", lang: "en", from: b.body))
    }

    /// Every message is asked about, sixty to a request (#389).
    func testEveryMessageIsAskedForInBoundedRequests() {
        let ids = Array(0..<150)
        let batches = ChatTranslations.batches(ids)
        XCTAssertEqual(batches.map(\.count), [60, 60, 30])
        XCTAssertEqual(Array(batches.joined()), ids)
        XCTAssertTrue(ChatTranslations.batches([Int]()).isEmpty)
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

    func testAReplyIsOpenedAtItselfInItsThread() {
        // Search, Activity and Sent keep both: the reply, and the thread it is in.
        let route = ChatRoute.conversation(view: "b:general", jump: "r1", thread: "p1")
        guard case let .conversation(view, jump, thread) = route else { return XCTFail("Not a conversation") }
        XCTAssertEqual(view, "b:general")
        XCTAssertEqual(jump, "r1")
        XCTAssertEqual(thread, "p1")
        XCTAssertEqual(ChatRoute.conversation(view: "b:general", jump: "m1"), ChatRoute.conversation(view: "b:general", jump: "m1", thread: nil))
    }

    func testOnlyNewMessagesAtTheBottomMoveAReaderDown() {
        // The first page: to its newest, unless opened at a message.
        XCTAssertTrue(ConversationView.followsNewest(previous: nil, openedAt: nil, atBottom: false, newestIsMine: false))
        XCTAssertFalse(ConversationView.followsNewest(previous: nil, openedAt: "m1", atBottom: true, newestIsMine: false))
        // Something new: followed at the bottom, or when it is your own.
        XCTAssertTrue(ConversationView.followsNewest(previous: "m9", openedAt: nil, atBottom: true, newestIsMine: false))
        XCTAssertTrue(ConversationView.followsNewest(previous: "m9", openedAt: "m1", atBottom: false, newestIsMine: true))
        // Reading further up: someone else's message leaves the place alone.
        XCTAssertFalse(ConversationView.followsNewest(previous: "m9", openedAt: nil, atBottom: false, newestIsMine: false))
    }

    func testFormatMarksToggleSwapAndContinue() {
        XCTAssertEqual(ChatFormat.toggleLine("hello", mark: "> "), "> hello")
        XCTAssertEqual(ChatFormat.toggleLine("> hello", mark: "> "), "hello")
        XCTAssertEqual(ChatFormat.toggleLine("> hello", mark: "- "), "- hello")
        // The bullet button writes the dot it is drawn with, and takes an old "- " off.
        XCTAssertEqual(ChatFormat.toggleLine("milk", mark: "• "), "• milk")
        XCTAssertEqual(ChatFormat.toggleLine("- milk", mark: "• "), "milk")
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

/// A chat notification tapped opens where its message is, not Home.
final class ChatNotificationTargetTests: XCTestCase {
    func testAMessagesNotificationNamesItsPlace() {
        // As the Worker sends it (worker/src/pushes.js pushMessage).
        let reply = PushService.MessageTarget(["kind": "message", "orgId": "org1", "channel": "c:general", "messageId": "m2", "parentId": "m1"])
        XCTAssertEqual(reply?.orgId, "org1")
        XCTAssertEqual(reply?.channel, "c:general")
        XCTAssertEqual(reply?.messageId, "m2")
        XCTAssertEqual(reply?.parentId, "m1")
        let post = PushService.MessageTarget(["kind": "message", "orgId": "org1", "channel": "dm:a|b", "messageId": "m3", "parentId": NSNull()])
        XCTAssertNotNil(post)
        XCTAssertNil(post?.parentId)
    }

    func testACardsOrAReadNotificationIsNotAMessageToOpen() {
        XCTAssertNil(PushService.MessageTarget(["cardId": "card1"]))
        XCTAssertNil(PushService.MessageTarget(["kind": "read", "orgId": "org1", "channel": "c:general"]))
        XCTAssertNil(PushService.MessageTarget(["kind": "message", "channel": "c:general"]))
    }

    func testACardsNotificationKeepsTheWorkspaceItIsIn() {
        // As the Worker sends it (worker/src/notify.js).
        let card = PushService.CardTarget(["cardId": "card1", "kind": "request", "orgId": "org-b"])
        XCTAssertEqual(card?.cardId, "card1")
        XCTAssertEqual(card?.orgId, "org-b")
        XCTAssertNil(PushService.CardTarget(["cardId": "card1"])?.orgId)
        XCTAssertNil(PushService.CardTarget(["kind": "message", "cardId": "card1", "channel": "c:general", "messageId": "m1"]))
        XCTAssertNil(PushService.CardTarget(["kind": "read", "orgId": "org1", "channel": "c:general"]))
        // The same card tapped twice is two taps, each opened.
        XCTAssertNotEqual(PushService.CardTarget(["cardId": "card1"]), PushService.CardTarget(["cardId": "card1"]))
    }
}

/// Messages that did not reach the server: kept for the account, workspace
/// and conversation they were written in, and across a relaunch.
final class ChatOutboxTests: XCTestCase {
    private func entry(_ id: String, at: String, user: String = "alice", org: String = "org-a", view: String = "b:general",
                       parent: String? = nil, also: Bool = false) -> ChatOutbox.Entry {
        ChatOutbox.Entry(clientId: id, user: user, orgId: org, view: view, text: "Words for \(id)", decide: false, parentId: parent,
                         alsoChannel: also, files: [], replyTo: nil, createdAt: at, reason: nil)
    }

    private var entries: [String: ChatOutbox.Entry] {
        let list = [
            entry("tmp-1", at: "2026-10-18T09:01:00Z"),
            entry("tmp-2", at: "2026-10-18T09:02:00Z", org: "org-b"),
            entry("tmp-3", at: "2026-10-18T09:03:00Z", user: "bob"),
            entry("tmp-4", at: "2026-10-18T09:04:00Z", view: "b:sales"),
            entry("tmp-5", at: "2026-10-18T09:05:00Z", parent: "p1"),
            entry("tmp-6", at: "2026-10-18T09:06:00Z", parent: "p1", also: true),
            entry("tmp-0", at: "2026-10-18T09:00:00Z"),
        ]
        return Dictionary(uniqueKeysWithValues: list.map { ($0.clientId, $0) })
    }

    func testAHeldMessageIsShownOnlyWhereItWasWritten() {
        // Another workspace's #general, or another account's, never shows it.
        XCTAssertEqual(ChatOutbox.held(entries, user: "alice", orgId: "org-a", view: "b:general", thread: nil).map(\.clientId), ["tmp-0", "tmp-1", "tmp-6"])
        XCTAssertEqual(ChatOutbox.held(entries, user: "alice", orgId: "org-b", view: "b:general", thread: nil).map(\.clientId), ["tmp-2"])
        XCTAssertEqual(ChatOutbox.held(entries, user: "bob", orgId: "org-a", view: "b:general", thread: nil).map(\.clientId), ["tmp-3"])
        // A thread's replies in the thread; one sent to the conversation too, in both.
        XCTAssertEqual(ChatOutbox.held(entries, user: "alice", orgId: "org-a", view: "b:general", thread: "p1").map(\.clientId), ["tmp-5", "tmp-6"])
    }

    func testHeldMessagesSurviveARelaunchUntilThereAreNone() throws {
        let suite = "chat-outbox-test-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        var kept = entries
        kept["tmp-1"]?.reason = "The network connection was lost."
        ChatOutbox.save(kept, to: defaults)
        XCTAssertEqual(ChatOutbox.load(from: defaults), kept)
        ChatOutbox.save([:], to: defaults)
        XCTAssertNil(defaults.data(forKey: ChatOutbox.key))
        // Signing out takes away every "chat.draft." key, these with them.
        XCTAssertTrue(ChatOutbox.key.hasPrefix("chat.draft."))
    }
}

/// What the chat store does when the server cannot be reached. With no
/// session on the phone every request fails before it leaves it.
@MainActor
final class ChatStoreFailureTests: XCTestCase {
    /// The store holds the app state weakly: each test keeps it, and says
    /// so last, to the end.
    private func offline() -> (store: ChatStore, app: AppState) {
        SessionStore.clear()
        let app = AppState(startServices: false)
        app.currentUser = User(id: "offline-reader", name: "Reader", role: "Member", teamID: "org-offline", githubUsername: nil)
        let store = ChatStore()
        store.bind(app)
        return (store, app)
    }

    func testAConversationThatCouldNotBeLoadedIsNotMarkedRead() async {
        let (store, app) = offline()
        await store.open("b:general")
        XCTAssertNil(store.readAt("b:general"))
        XCTAssertNotNil(store.error)
        XCTAssertEqual(app.currentUser?.teamID, "org-offline")
    }

    private func mine(_ id: String, _ body: String) throws -> ChatMessage {
        let json = #"{"id":"\#(id)","channel":"b:general","kind":"message","body":"\#(body)","mine":true,"createdAt":"2026-10-01T09:00:00.000Z"}"#
        return try JSONDecoder().decode(ChatMessage.self, from: Data(json.utf8))
    }

    func testAnEditTheServerDidNotTakeIsNotReportedSaved() async throws {
        let (store, app) = offline()
        let m = try mine("m1", "before")
        let saved = await store.edit(m, to: "after")
        XCTAssertFalse(saved, "A failed save must leave the edit open")
        XCTAssertEqual(app.currentUser?.teamID, "org-offline")
    }

    func testSwitchingWorkspaceLeavesNothingOfTheLastOneShowing() async {
        let (store, app) = offline()
        await store.open("b:general")
        XCTAssertNotNil(store.error)
        store.pendingOpen = PushService.MessageTarget(["kind": "message", "orgId": "org-offline", "channel": "b:general", "messageId": "m1"])
        app.currentUser?.teamID = "org-other"
        XCTAssertNil(store.error)
        XCTAssertNil(store.pendingOpen)
        XCTAssertTrue(store.messages.isEmpty)
    }

    func testAMessageThatCannotBeReachedIsReportedNotFound() async {
        let (store, app) = offline()
        await store.open("b:general")
        let found = await store.loadUntil("b:general", contains: "far-back")
        XCTAssertFalse(found)
        XCTAssertEqual(app.currentUser?.teamID, "org-offline")
    }

    func testACancellationTheServerDidNotTakeIsNotReportedDone() async {
        let (store, app) = offline()
        let later = ChatScheduled(id: "s1", body: "Reminder", sendAt: "2026-10-20T09:00:00.000Z", channel: "b:general", parentId: nil)
        let result = await store.cancelScheduled(later)
        XCTAssertEqual(result, .failed)
        XCTAssertTrue(store.cancelling.isEmpty)
        XCTAssertEqual(app.currentUser?.teamID, "org-offline")
    }
}
