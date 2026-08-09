# Settings Screens (History, Context, API Key) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn three dimmed "Coming soon" rows into working features — History (with an Undo that makes rollbacks real), Context (that actually reaches the routing prompt), and a bring-your-own API key that is never stored on our servers — and delete the row whose feature no longer exists.

**Architecture:** Worker changes come first so the client has something to talk to: `/ai/route` accepts an optional `senderContext` in its body and an optional `x-ai-key` header, and the relay learns to log a decision-carrying `card_updated` as a `decided` event. Then iOS gains a `CardEvent` model, a history fetch, three screens reachable from `YouView`, an Undo action that sends the relay's existing `rollback` message, and a Keychain-stored API key sent per request.

**Tech Stack:** Cloudflare Workers + D1 (Vitest), SwiftUI (xcodegen/xcodebuild).

## Verification model

- **Worker:** `cd /Users/torutano/HonmaruAI/worker && npm test` — **41 tests green today**; each task adds tests and must leave the suite green.
- **iOS:** no test target. A task is verified by
  `cd /Users/torutano/HonmaruAI && xcodegen generate && xcodebuild -project TikTokForWork.xcodeproj -scheme TikTokForWork -destination 'generic/platform=iOS Simulator' -configuration Debug build 2>&1 | tail -6` ending in `** BUILD SUCCEEDED **`, plus simulator screenshots where the change is visual.

## Contracts this plan relies on (already deployed)

- `GET /orgs/:owner/:repo/events?limit=50`, header `x-session-token` → `{ events: [{ id, cardId, type, action, actorUserId, note, snapshot, createdAt }] }`; 401 without a session, 403 for a non-member.
- Relay WebSocket accepts `{type:"rollback", payload:{cardId}}` and `{type:"context_updated", payload:{context, userId?}}`.
- `POST /ai/route` body: `{ text, sender, organization, priorityOverride, readerLanguage }`.

## File Structure

```
worker/
  src/index.js            # /ai/route: read senderContext + x-ai-key
  src/routing.js          # buildUserPrompt includes sender context
  src/relay.js            # a decision-carrying card_updated logs as `decided`
  test/routing.test.js    # (extend) prompt carries context
  test/openai-route.test.js # (extend) per-request key is used
  test/audit.test.js      # (extend) card_updated with a decision logs `decided`
TikTokForWork/
  Models/CardEvent.swift        # NEW: one history entry
  Services/HistoryService.swift # NEW: fetch the org timeline
  Services/SessionStore.swift   # + apiKey (Keychain)
  Services/AIService.swift      # + senderContext body field, x-ai-key header
  Services/WebSocketService.swift # + rollback / contextUpdated events
  App/AppState.swift            # + userContext (persisted), publishContext
  Features/Settings/HistoryView.swift  # NEW
  Features/Settings/ContextView.swift  # NEW
  Features/Settings/APIKeyView.swift   # NEW
  Features/Shell/YouView.swift  # rows wired; dead row deleted
  Features/Feed/DecisionCardView.swift # + Undo on a decided card
  Localizable.xcstrings         # new keys + ja
```

---

# Part 1 — Worker

## Task 1: Routing uses the sender's context

**Files:**
- Modify: `worker/src/index.js`, `worker/src/routing.js`
- Test: `worker/test/routing.test.js`

- [ ] **Step 1: Add the failing test to `worker/test/routing.test.js`** (append)

```js
test("buildUserPrompt carries the sender's context when supplied", () => {
  const org = { nodes: [{ id: "octocat", kind: "person", label: "octocat · Admin" }], edges: [] };
  const prompt = buildUserPrompt({
    text: "ship it",
    sender: { name: "octocat", id: "octocat", role: "Admin" },
    organization: org,
    readerLanguage: "en",
    senderContext: "I own billing decisions and hate meetings.",
  });
  expect(prompt).toContain("Sender context:");
  expect(prompt).toContain("I own billing decisions");
});

test("buildUserPrompt omits the context heading when there is none", () => {
  const org = { nodes: [{ id: "octocat", kind: "person", label: "octocat · Admin" }], edges: [] };
  const prompt = buildUserPrompt({
    text: "ship it",
    sender: { name: "octocat", id: "octocat", role: "Admin" },
    organization: org,
    readerLanguage: "en",
  });
  expect(prompt).not.toContain("Sender context:");
});
```

(`buildUserPrompt` is already imported at the top of this test file.)

- [ ] **Step 2: Run to verify it fails**

Run: `cd worker && npm test -- routing.test.js`
Expected: FAIL — the prompt has no `Sender context:`.

- [ ] **Step 3: Thread the context through `worker/src/routing.js`**

Change `buildUserPrompt` to accept and render it:

```js
export function buildUserPrompt({ text, sender, organization, readerLanguage, senderContext }) {
  const orgContext = organizationContext(organization);
  const contextBlock = senderContext && senderContext.trim()
    ? `\nSender context: ${senderContext.trim()}\n`
    : "";
  return `Sender: ${sender.name} (${sender.id}, ${sender.role})
Reader language: ${readerLanguage || "ja"}
Instruction: ${text}
${contextBlock}
Organization:
${orgContext}`;
}
```

Then pass it down: `routeInstructionWithOpenRouter({...})` already destructures its arguments — add `senderContext` to its parameter list and to the `buildUserPrompt({...})` call inside it; add `senderContext` to `routeInstruction({...})`'s parameters and to the object it forwards to `routeInstructionWithOpenRouter`. (Read those two functions and thread the field the same way `readerLanguage` is already threaded.)

- [ ] **Step 4: Read it from the request in `worker/src/index.js`**

In the `/ai/route` handler, add the field to the `routeInstruction({...})` call:

```js
        senderContext: body.senderContext,
```

- [ ] **Step 5: Run the routing tests, then the full suite**

Run: `cd worker && npm test -- routing.test.js` → PASS.
Run: `cd worker && npm test` → PASS (41 + 2 = 43). Paste output.

- [ ] **Step 6: Commit**

```bash
git add worker/src/routing.js worker/src/index.js worker/test/routing.test.js
git commit -m "feat(worker): routing weighs the sender's context"
```

---

## Task 2: Bring-your-own API key

**Files:**
- Modify: `worker/src/index.js`
- Test: `worker/test/openai-route.test.js`

- [ ] **Step 1: Add the failing test to `worker/test/openai-route.test.js`** (append)

This drives the real endpoint and asserts the outgoing call used the caller's key.

```js
test("a caller-supplied key is used for routing", async () => {
  let seenAuth;
  fetchMock.get("https://api.openai.com")
    .intercept({
      path: "/v1/chat/completions",
      method: "POST",
      headers(h) { seenAuth = h.authorization || h.Authorization; return true; },
    })
    .reply(200, () => toolCallReply("hubot"));

  const res = await SELF.fetch("https://example.com/ai/route", {
    method: "POST",
    headers: { "content-type": "application/json", "x-ai-key": "sk-user-key" },
    body: JSON.stringify({
      text: "Ask hubot to review the deploy",
      sender: { id: "octocat", name: "octocat" },
      organization: REAL_ORG,
    }),
  });

  expect(res.status).toBe(200);
  const card = await res.json();
  expect(card.routedBy).toBe("OpenAI");
  expect(seenAuth).toBe("Bearer sk-user-key");
});
```

If the installed undici does not support a `headers(h)` matcher function, capture the header inside the `.reply()` callback instead (it receives the request options, which include `headers`). Do NOT drop the `seenAuth` assertion — proving the user's key is the one used is the whole point of the test.

`REAL_ORG` and `toolCallReply` already exist at the top of this file.

- [ ] **Step 2: Run to verify it fails**

Run: `cd worker && npm test -- openai-route.test.js`
Expected: FAIL — no key is read from the header, so with no `OPENAI_API_KEY` in the test env the call never happens (`routedBy` is `"fallback"`).

- [ ] **Step 3: Accept a per-request key in `worker/src/index.js`**

Change `providerConfig` to prefer a caller-supplied key:

```js
// A user's own key is never stored on our side — it arrives per request and is
// used for that request only. Never log it.
function providerConfig(env, userKey) {
  const openaiKey = userKey || env.OPENAI_API_KEY;
  if (openaiKey) {
    return {
      providerName: "OpenAI",
      endpoint: "https://api.openai.com/v1/chat/completions",
      apiKey: openaiKey,
      model: env.OPENAI_MODEL || "gpt-4o-mini",
    };
  }
  if (env.OPENROUTER_API_KEY) {
    return {
      providerName: "OpenRouter",
      endpoint: "https://openrouter.ai/api/v1/chat/completions",
      apiKey: env.OPENROUTER_API_KEY,
      model: env.OPENROUTER_MODEL || "inclusionai/ling-3.0-flash:free",
      appName: "TikTok for Work",
      appUrl: "https://tiktokforwork.dev",
    };
  }
  return undefined;
}
```

In the `/ai/route` handler, read the header and pass it:

```js
      const userKey = request.headers.get("x-ai-key") || undefined;
```
and change the call to `openRouter: providerConfig(env, userKey),`.

- [ ] **Step 4: Run the tests, then the full suite**

Run: `cd worker && npm test -- openai-route.test.js` → PASS (3 tests).
Run: `cd worker && npm test` → PASS (43 + 1 = 44). Paste output.

- [ ] **Step 5: Commit**

```bash
git add worker/src/index.js worker/test/openai-route.test.js
git commit -m "feat(worker): route with a caller-supplied API key"
```

---

## Task 3: A decision sent as card_updated is logged as a decision

**Files:**
- Modify: `worker/src/relay.js`
- Test: `worker/test/audit.test.js`

The iOS client applies a decision locally and publishes the whole card with
`card_updated` — it never uses the AG-UI `submit_decision` path. Without this,
every real approval lands in the history as a bland `updated`.

- [ ] **Step 1: Add the failing test to `worker/test/audit.test.js`** (append)

```js
test("a decision published as card_updated is recorded as a decision", async () => {
  const ws = await open();
  ws.send(JSON.stringify({ type: "join", payload: { userId: "octocat", protocol: "agui/1" } }));
  await sleep(40);
  ws.send(JSON.stringify({ type: "card_created", payload: { card: card("c-upd") } }));
  await sleep(60);
  const decided = {
    ...card("c-upd"),
    status: "approved",
    decision: { action: "approve", actorUserID: "hubot", decidedAt: "2026-08-09T02:00:00Z", note: "fine" },
  };
  ws.send(JSON.stringify({ type: "card_updated", payload: { card: decided } }));
  await sleep(80);

  const events = await listCardEvents(env.DB, "audit-org", "c-upd");
  expect(events.map((e) => e.type)).toEqual(["created", "decided"]);
  expect(events[1].action).toBe("approve");
  expect(events[1].actorUserId).toBe("hubot");
  expect(events[1].note).toBe("fine");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd worker && npm test -- audit.test.js`
Expected: FAIL — the second event is `updated`, not `decided`.

- [ ] **Step 3: Classify the event in `worker/src/relay.js`**

In the `if (type === "card_created" || type === "card_updated")` branch, replace the `await this.log(orgId, {...})` call with:

```js
      // The iOS client decides locally and republishes the whole card, so a
      // card_updated that carries a decision IS a decision — recording it as a
      // bland "updated" would make the history useless.
      const decision = type === "card_updated" ? card.decision : undefined;
      await this.log(orgId, {
        cardId: card.id,
        type: decision?.action ? "decided" : (type === "card_created" ? "created" : "updated"),
        action: decision?.action,
        actorUserId: decision?.action
          ? (decision.actorUserID || att.userId)
          : (type === "card_created" ? (card.senderUserID || att.userId) : att.userId),
        note: decision?.note || decision?.replyText,
        snapshot: card,
      });
```

- [ ] **Step 4: Run the audit tests, then the full suite**

Run: `cd worker && npm test -- audit.test.js` → PASS (4 tests).
Run: `cd worker && npm test` → PASS (44 + 1 = 45). Paste output.

- [ ] **Step 5: Deploy the three Worker changes**

Run: `cd worker && npx wrangler deploy`
Expected: a new Version ID.
Then smoke the unchanged surface: `curl -s https://tiktokforwork.torubj0904.workers.dev/health` → the usual JSON with `aiRouting:true`.

- [ ] **Step 6: Commit**

```bash
git add worker/src/relay.js worker/test/audit.test.js
git commit -m "feat(worker): record client-side decisions as decisions"
```

---

# Part 2 — iOS

## Task 4: Event model, history fetch, and the API key store

**Files:**
- Create: `TikTokForWork/Models/CardEvent.swift`, `TikTokForWork/Services/HistoryService.swift`
- Modify: `TikTokForWork/Services/SessionStore.swift`, `TikTokForWork/Services/AIService.swift`

- [ ] **Step 1: Create `TikTokForWork/Models/CardEvent.swift`**

```swift
import Foundation

/// One entry in a card's history, as served by the relay's event log.
struct CardEvent: Identifiable, Decodable, Equatable {
    let id: String
    let cardId: String
    let type: String
    let action: String?
    let actorUserId: String?
    let note: String?
    let createdAt: String
    let snapshot: Snapshot?

    /// Only the parts of the recorded card the history screen shows.
    struct Snapshot: Decodable, Equatable {
        let title: String?
        let status: String?
    }

    /// "approve" reads better than "decided" when both are present.
    var headline: String {
        switch type {
        case "created": return String(localized: "Created")
        case "updated": return String(localized: "Updated")
        case "deleted": return String(localized: "Deleted")
        case "rolled_back": return String(localized: "Undone")
        case "decided":
            switch action {
            case "approve": return String(localized: "Approved")
            case "decline": return String(localized: "Declined")
            case "reply": return String(localized: "Replied")
            default: return String(localized: "Decided")
            }
        default: return type
        }
    }
}
```

- [ ] **Step 2: Create `TikTokForWork/Services/HistoryService.swift`**

```swift
import Foundation

enum HistoryError: LocalizedError {
    case notSignedIn
    case forbidden
    case server(Int)

    var errorDescription: String? {
        switch self {
        case .notSignedIn: String(localized: "Sign in with GitHub to see your team's history.")
        case .forbidden: String(localized: "You are not a member of this repository.")
        case .server(let code): String(localized: "History request failed (\(code)).")
        }
    }
}

/// Reads the org's activity log. The backend gates this by membership, so the
/// errors below are the ones a normal user can actually hit.
enum HistoryService {
    private struct Envelope: Decodable { let events: [CardEvent] }

    static func fetch(owner: String, repo: String, backendBaseURL: URL, limit: Int = 50) async throws -> [CardEvent] {
        guard let token = SessionStore.sessionToken else { throw HistoryError.notSignedIn }
        guard let url = URL(string: "orgs/\(owner)/\(repo)/events?limit=\(limit)", relativeTo: backendBaseURL) else {
            throw HistoryError.server(0)
        }
        var request = URLRequest(url: url)
        request.timeoutInterval = 15
        request.setValue(token, forHTTPHeaderField: "x-session-token")

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw HistoryError.server(0) }
        switch http.statusCode {
        case 200: return try JSONDecoder().decode(Envelope.self, from: data).events
        case 401: throw HistoryError.notSignedIn
        case 403: throw HistoryError.forbidden
        default: throw HistoryError.server(http.statusCode)
        }
    }
}
```

- [ ] **Step 3: Add `apiKey` to `TikTokForWork/Services/SessionStore.swift`**

Add `static let apiKey = "apiKey"` to the `Key` enum, and the accessor mirroring `githubToken` exactly (the file uses `read(_:)` / `write(_:key:)` / `delete(_:)`):

```swift
    static var apiKey: String? {
        get { read(Key.apiKey) }
        set { write(newValue, key: Key.apiKey) }
    }
```

Do NOT clear it in `clear()`: signing out of GitHub should not throw away a key the user pasted. (Leave `clear()` untouched.)

- [ ] **Step 4: Send the context and the key from `TikTokForWork/Services/AIService.swift`**

Add the field to the request struct:

```swift
private struct RouteInstructionRequest: Encodable {
    let text: String
    let sender: User
    let organization: OrganizationGraph
    let priorityOverride: String?
    let readerLanguage: String
    /// What the sender told their AI about how they work.
    let senderContext: String?
}
```

Add a `senderContext: String?` parameter (no default) to both `draftInstruction(...)` and `routeInstruction(...)`, forward it from the former to the latter, put it in the `RouteInstructionRequest(...)`, and attach the key header where the request is built:

```swift
        if let key = SessionStore.apiKey, !key.isEmpty {
            request.setValue(key, forHTTPHeaderField: "x-ai-key")
        }
```

- [ ] **Step 5: Update the caller**

`TikTokForWork/ViewModels/FeedViewModel.swift` calls `appState.aiService.draftInstruction(...)`. Add `senderContext: appState.userContext` to that call. (`userContext` is added in Task 5; if you build before Task 5, this will not compile — build at the end of Task 5.)

- [ ] **Step 6: Commit (build deferred to Task 5)**

```bash
git add TikTokForWork/Models/CardEvent.swift TikTokForWork/Services/HistoryService.swift TikTokForWork/Services/SessionStore.swift TikTokForWork/Services/AIService.swift TikTokForWork/ViewModels/FeedViewModel.swift
git commit -m "feat(ios): history model, fetch, and per-user API key plumbing"
```

---

## Task 5: Context state and the two relay messages

**Files:**
- Modify: `TikTokForWork/App/AppState.swift`, `TikTokForWork/Services/WebSocketService.swift`

- [ ] **Step 1: Add the outbound events in `TikTokForWork/Services/WebSocketService.swift`**

Add two cases to `OutboundEvent`:

```swift
    case rollback(cardID: String)
    case contextUpdated(text: String)
```

and their envelopes inside `var envelope: [String: Any]`:

```swift
        case .rollback(let cardID):
            return ["type": "rollback", "payload": ["cardId": cardID]]
        case .contextUpdated(let text):
            return ["type": "context_updated", "payload": ["context": ["text": text]]]
```

Add the two publish helpers next to the existing `publishUpdated(...)` (read it and match its style — it is an `async` method that calls `try? await send(...)`):

```swift
    func publishRollback(cardID: String) async {
        try? await send(.rollback(cardID: cardID))
    }

    func publishContext(_ text: String) async {
        try? await send(.contextUpdated(text: text))
    }
```

- [ ] **Step 2: Add the context to `TikTokForWork/App/AppState.swift`**

Add next to the other `@Published` properties:

```swift
    /// What this user told their AI about how they work. Kept locally so it can
    /// ride along with every routing request, and mirrored to the relay so it
    /// survives a reinstall.
    @Published var userContext: String = UserDefaults.standard.string(forKey: "userContext") ?? "" {
        didSet { UserDefaults.standard.set(userContext, forKey: "userContext") }
    }

    func publishUserContext() async {
        await webSocketService.publishContext(userContext)
    }
```

- [ ] **Step 3: Build**

Run the iOS build command. Expected: `** BUILD SUCCEEDED **` (this also compiles Task 4's changes).

- [ ] **Step 4: Commit**

```bash
git add TikTokForWork/App/AppState.swift TikTokForWork/Services/WebSocketService.swift
git commit -m "feat(ios): user context state and rollback/context relay messages"
```

---

## Task 6: The three screens

**Files:**
- Create: `TikTokForWork/Features/Settings/HistoryView.swift`, `ContextView.swift`, `APIKeyView.swift`

- [ ] **Step 1: Create `TikTokForWork/Features/Settings/HistoryView.swift`**

```swift
import SwiftUI

/// Everything that has happened in this repo's feed, newest first. The backend
/// gates it by membership, so a guest is told to sign in rather than shown a
/// failure.
struct HistoryView: View {
    @EnvironmentObject private var appState: AppState
    @State private var events: [CardEvent] = []
    @State private var message: String?
    @State private var isLoading = true

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                if isLoading {
                    ProgressView().frame(maxWidth: .infinity).padding(.top, Theme.Spacing.xl)
                } else if let message {
                    Text(message)
                        .font(Theme.TypeScale.body)
                        .foregroundStyle(Theme.Colors.textSecondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.top, Theme.Spacing.xl)
                } else if events.isEmpty {
                    Text(String(localized: "Nothing has happened yet."))
                        .font(Theme.TypeScale.body)
                        .foregroundStyle(Theme.Colors.textSecondary)
                        .padding(.top, Theme.Spacing.xl)
                } else {
                    ForEach(events) { event in
                        row(event)
                    }
                }
            }
            .padding(Theme.Spacing.md)
        }
        .navigationTitle(Text("History"))
        .task { await load() }
    }

    private func row(_ event: CardEvent) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack {
                Text(event.headline)
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(Theme.Colors.textPrimary)
                Spacer()
                Text(RelativeTime.since(event.createdAt))
                    .font(Theme.TypeScale.micro)
                    .foregroundStyle(Theme.Colors.textTertiary)
            }
            Text(event.snapshot?.title ?? event.cardId)
                .font(Theme.TypeScale.caption)
                .foregroundStyle(Theme.Colors.textSecondary)
                .lineLimit(2)
            if let actor = event.actorUserId {
                Text(actor)
                    .font(Theme.TypeScale.micro)
                    .foregroundStyle(Theme.Colors.textTertiary)
            }
        }
        .padding(Theme.Spacing.md)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.Colors.background)
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.image))
        .overlay {
            RoundedRectangle(cornerRadius: Theme.Radius.image)
                .strokeBorder(Theme.Colors.border, lineWidth: 1)
        }
    }

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        guard let repository = appState.githubService.connection?.repository,
              let base = appState.backendBaseURL else {
            message = String(localized: "Sign in with GitHub to see your team's history.")
            return
        }
        let parts = repository.split(separator: "/")
        guard parts.count == 2 else {
            message = String(localized: "Sign in with GitHub to see your team's history.")
            return
        }
        do {
            events = try await HistoryService.fetch(
                owner: String(parts[0]), repo: String(parts[1]), backendBaseURL: base
            )
            message = nil
        } catch {
            message = error.localizedDescription
        }
    }
}

/// Coarse relative time — "3m", "2h", "5d". Precision beyond this is noise in a
/// activity list.
enum RelativeTime {
    static func since(_ iso: String) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let date = formatter.date(from: iso) ?? ISO8601DateFormatter().date(from: iso)
        guard let date else { return "" }
        let seconds = Int(Date().timeIntervalSince(date))
        if seconds < 60 { return String(localized: "just now") }
        if seconds < 3600 { return "\(seconds / 60)m" }
        if seconds < 86_400 { return "\(seconds / 3600)h" }
        return "\(seconds / 86_400)d"
    }
}
```

- [ ] **Step 2: Create `TikTokForWork/Features/Settings/ContextView.swift`**

```swift
import SwiftUI

/// What your AI should know about you. This rides along with every routing
/// request, so it changes who your instructions reach.
struct ContextView: View {
    @EnvironmentObject private var appState: AppState
    @Environment(\.dismiss) private var dismiss
    @State private var draft: String = ""

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            Text(String(localized: "Tell your AI how you work — what you own, what you care about, who to involve. It uses this when routing your instructions."))
                .font(Theme.TypeScale.caption)
                .foregroundStyle(Theme.Colors.textSecondary)

            TextEditor(text: $draft)
                .font(Theme.TypeScale.body)
                .scrollContentBackground(.hidden)
                .padding(Theme.Spacing.sm)
                .frame(minHeight: 220)
                .background(Theme.Colors.surface)
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.image))
                .overlay {
                    RoundedRectangle(cornerRadius: Theme.Radius.image)
                        .strokeBorder(Theme.Colors.border, lineWidth: 1)
                }

            Spacer()
        }
        .padding(Theme.Spacing.md)
        .navigationTitle(Text("Context"))
        .onAppear { draft = appState.userContext }
        .onDisappear {
            appState.userContext = draft
            Task { await appState.publishUserContext() }
        }
    }
}
```

- [ ] **Step 3: Create `TikTokForWork/Features/Settings/APIKeyView.swift`**

```swift
import SwiftUI

/// Bring your own OpenAI key. It is kept in this device's Keychain and sent with
/// your routing requests — it is never stored on our servers.
struct APIKeyView: View {
    @State private var key: String = ""
    @State private var saved = false

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            Text(String(localized: "Use your own OpenAI key for routing. It stays in this device's Keychain and is sent only with your own requests — we never store it on our servers."))
                .font(Theme.TypeScale.caption)
                .foregroundStyle(Theme.Colors.textSecondary)

            SecureField("sk-…", text: $key)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .font(Theme.TypeScale.body)
                .padding(Theme.Spacing.sm)
                .background(Theme.Colors.surface)
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.image))
                .overlay {
                    RoundedRectangle(cornerRadius: Theme.Radius.image)
                        .strokeBorder(Theme.Colors.border, lineWidth: 1)
                }

            HStack(spacing: Theme.Spacing.sm) {
                Button(String(localized: "Save")) {
                    SessionStore.apiKey = key.trimmingCharacters(in: .whitespacesAndNewlines)
                    saved = true
                }
                .font(.system(size: 15, weight: .medium))

                Button(String(localized: "Clear")) {
                    key = ""
                    SessionStore.apiKey = nil
                    saved = false
                }
                .font(.system(size: 15))
                .foregroundStyle(Theme.Colors.reject)

                Spacer()

                if saved {
                    Text(String(localized: "Saved"))
                        .font(Theme.TypeScale.micro)
                        .foregroundStyle(Theme.Colors.textTertiary)
                }
            }

            Spacer()
        }
        .padding(Theme.Spacing.md)
        .navigationTitle(Text("API key"))
        .onAppear { key = SessionStore.apiKey ?? "" }
    }
}
```

- [ ] **Step 4: Build**

Run the iOS build command. Expected: `** BUILD SUCCEEDED **`. If `Theme.TypeScale.micro` or `Theme.Radius.image` do not exist under those names, read `TikTokForWork/Design/Theme.swift` and use the actual ones.

- [ ] **Step 5: Commit**

```bash
git add TikTokForWork/Features/Settings/
git commit -m "feat(ios): history, context, and API key screens"
```

---

## Task 7: Wire the rows and delete the dead one

**Files:**
- Modify: `TikTokForWork/Features/Shell/YouView.swift`, `TikTokForWork/Localizable.xcstrings`

- [ ] **Step 1: Replace the pending rows in `YouView`**

`YouView` currently renders two groups of `pendingRow(...)`. Replace them with:

```swift
                group {
                    pendingRow(String(localized: "Plan"))
                    navRow(String(localized: "API key")) { APIKeyView() }
                    navRow(String(localized: "Context")) { ContextView() }
                }

                group {
                    navRow(String(localized: "History")) { HistoryView() }
                    pendingRow(String(localized: "Notifications"))
                }
```

`Set classic view as default` is gone — the Classic view it toggled was deleted in Phase 4C. `Plan` and `Notifications` stay dimmed; they are separate sub-projects.

- [ ] **Step 2: Add `navRow` and a navigation container**

`YouView`'s body is a `ScrollView`; pushing a screen needs a `NavigationStack`. Wrap the existing `ScrollView { … }` in `NavigationStack { … }` (keep every existing modifier attached to the `ScrollView`), and add this helper beside `pendingRow`:

```swift
    /// A row that pushes a real screen, styled like `row(_:value:)`.
    private func navRow<Destination: View>(
        _ title: String,
        @ViewBuilder destination: @escaping () -> Destination
    ) -> some View {
        NavigationLink { destination().environmentObject(appState) } label: {
            HStack {
                Text(title)
                    .font(.system(size: 15))
                    .foregroundStyle(Theme.Colors.textPrimary)
                Spacer()
                Image(systemName: "chevron.right")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(Theme.Colors.textTertiary)
            }
            .padding(.horizontal, Theme.Spacing.md)
            .padding(.vertical, 13)
        }
        .buttonStyle(.plain)
    }
```

- [ ] **Step 3: Add the Japanese strings to `TikTokForWork/Localizable.xcstrings`**

Add `ja` entries for every new key that lacks one — search each before adding, because a duplicate key breaks the JSON:
`History`→`履歴`, `Context`→`コンテキスト`, `Nothing has happened yet.`→`まだ何も起きていません。`,
`Sign in with GitHub to see your team's history.`→`チームの履歴を見るには GitHub でサインインしてください。`,
`You are not a member of this repository.`→`このリポジトリのメンバーではありません。`,
`Created`→`作成`, `Updated`→`更新`, `Deleted`→`削除`, `Undone`→`取り消し`, `Approved`→`承認`,
`Declined`→`却下`, `Replied`→`返信`, `Decided`→`決定`, `just now`→`たった今`,
`Save`→`保存`, `Saved`→`保存しました`, `Undo`→`取り消す`,
`Tell your AI how you work — what you own, what you care about, who to involve. It uses this when routing your instructions.`→`あなたの仕事の進め方を AI に伝えてください。担当領域、重視すること、巻き込むべき相手。指示のルーティングに使われます。`,
`Use your own OpenAI key for routing. It stays in this device's Keychain and is sent only with your own requests — we never store it on our servers.`→`ルーティングにご自身の OpenAI キーを使えます。キーはこの端末のキーチェーンにのみ保存され、あなたのリクエストにのみ送信されます。当方のサーバーには保存しません。`
(`Clear` and `API key` already exist — verify before adding.)

Also delete the now-unused `Set classic view as default` entry.

Validate: `python3 -c "import json;json.load(open('TikTokForWork/Localizable.xcstrings'));print('valid json')"` → must print `valid json`.

- [ ] **Step 4: Build**

Run the iOS build command. Expected: `** BUILD SUCCEEDED **`.

- [ ] **Step 5: Simulator screenshots**

```bash
DEV=$(xcrun simctl list devices booted | grep -oE '[0-9A-F-]{36}' | head -1)
APP=$(find ~/Library/Developer/Xcode/DerivedData/TikTokForWork-*/Build/Products/Debug-iphonesimulator -maxdepth 1 -name "TikTokForWork.app" | head -1)
xcrun simctl install "$DEV" "$APP" && xcrun simctl launch "$DEV" com.honmaru.ai -RelayURL "ws://127.0.0.1:9999"
sleep 5 && xcrun simctl io "$DEV" screenshot /tmp/settings_rows.png
```
Confirm the app launches. Driving taps to reach each screen may not be possible headlessly — if not, report that and leave the visual check to the device pass in Task 8.

- [ ] **Step 6: Commit**

```bash
git add TikTokForWork/Features/Shell/YouView.swift TikTokForWork/Localizable.xcstrings
git commit -m "feat(ios): wire settings rows, drop the dead classic-view row"
```

---

## Task 8: Undo a decision

**Files:**
- Modify: `TikTokForWork/Features/Feed/DecisionCardView.swift`

- [ ] **Step 1: Add an Undo affordance to a decided card**

READ `DecisionCardView.swift` first to find where a decided card renders (it shows a status/result rather than the approve/decline actions). Add, in that decided branch:

```swift
                Button(String(localized: "Undo")) {
                    Task { await appState.webSocketService.publishRollback(cardID: card.id) }
                }
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(Theme.Colors.interactive)
```

The view needs `@EnvironmentObject private var appState: AppState` if it does not already have one; if adding it, verify every call site injects it (the feed already passes `appState` down — check `FeedView`).

The relay reverts the card to `pending`, broadcasts `decision_rolled_back`, and logs a `rolled_back` event whose snapshot preserves the decision — so the undo shows up in History.

- [ ] **Step 2: Build**

Run the iOS build command. Expected: `** BUILD SUCCEEDED **`.

- [ ] **Step 3: Ship to TestFlight**

```bash
cd /Users/torutano/HonmaruAI
./scripts/release.sh build 1.0
./scripts/release.sh testflight --yes
```
Expected: a new build number with `processingState: VALID`. (If the group assignment step fails with "no resource of type 'builds'", that is App Store Connect indexing lag — the build is uploaded; assign it in the TestFlight UI once it appears.)

- [ ] **Step 4: Commit**

```bash
git add TikTokForWork/Features/Feed/DecisionCardView.swift
git commit -m "feat(ios): undo a decision"
```

- [ ] **Step 5: Device checklist (run by the user)**

1. Settings shows **API key, Context, History** as tappable rows; **Plan** and **Notifications** still dimmed; **Set classic view as default** is gone.
2. Context: write a sentence, leave the screen, return — it persisted.
3. Send an instruction; the routing reflects the context (e.g. naming the owner you described).
4. Approve a card, open History — the entry reads **Approved**, with your login and the card title.
5. Tap **Undo** on that card; History gains an **Undone** entry and the card returns to pending.
6. Paste an OpenAI key, save, send an instruction — routing still works (now on your key).

---

## Self-Review Notes (addressed)

- **Spec coverage:** History screen + org fetch + states (Tasks 4, 6, 7); Undo making rollback real (Task 8); Context editor, relay persistence, and prompt injection (Tasks 1, 5, 6); API key in Keychain + `x-ai-key` + Worker preference, never stored server-side (Tasks 2, 4, 6); dead row deleted (Task 7).
- **Gap found while planning and fixed:** iOS decides locally and publishes `card_updated`, so the audit log would have recorded every real approval as `updated`. Task 3 classifies a decision-carrying update as `decided` — without it the History screen is meaningless.
- **Type consistency:** `CardEvent` decodes exactly the JSON the deployed endpoint returns (`id/cardId/type/action/actorUserId/note/createdAt/snapshot`); `HistoryService.fetch(owner:repo:backendBaseURL:limit:)` is the only caller; `SessionStore.apiKey` is read in `AIService` (header) and written in `APIKeyView`; `publishRollback(cardID:)` / `publishContext(_:)` match the `OutboundEvent` cases added in Task 5.
- **Ordering:** Task 4 references `appState.userContext`, which Task 5 adds — called out in Task 4 Step 5, with the build deferred to Task 5.
- **Guest path:** no session → History shows the sign-in message instead of an error; the API key still works (it is device-local and `/ai/route` needs no session).
