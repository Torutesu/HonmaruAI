# Phase 4: iOS — Real Identity & Real Org Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the iOS app talk to the deployed Cloudflare backend and run on real identities and a real org: the signed-in GitHub user is the app user, the org is that repo's collaborators, and the feed fills only from real AI routing — no persona picker, no demo org, no seeded cards.

**Architecture:** Point `AppConfig.relayURL` at the deployed Worker (`wss://…workers.dev`; `BackendURL.httpBase` already maps `wss→https`). Capture the app `sessionToken` from the OAuth token exchange and persist it. The GitHub sign-in + repository pick (which already yields the user's `login` and the `owner/repo`) becomes the only way in; the authenticated `User.id` is the GitHub login (matching the backend's member-id convention). The app fetches `GET /orgs/:owner/:repo/graph` (auth via `x-session-token`) and uses that `OrganizationGraph` for AI routing and the org view; the relay `join` carries the `sessionToken` and uses the repo full name as `orgId`.

**Tech Stack:** SwiftUI, `xcodegen` + `xcodebuild`, URLSession/ASWebAuthenticationSession, the deployed Worker at `https://tiktokforwork.torubj0904.workers.dev`.

## Verification model (no test target exists)

This project has **no unit/UI test target**, so tasks are verified by a successful build, not by unit tests:

```
cd /Users/torutano/HonmaruAI
xcodegen generate
xcodebuild -project TikTokForWork.xcodeproj -scheme TikTokForWork \
  -destination 'generic/platform=iOS Simulator' -configuration Debug build
```

"Build succeeds" = the command ends with `** BUILD SUCCEEDED **`. Each task ends by running this and confirming success. GitHub-login runtime behavior (ASWebAuthenticationSession) cannot be automated in a subagent; the end-of-plan **Manual simulator checklist** covers it and is run by the user.

## Scope

In scope: backend connection, sessionToken plumbing, auth-first entry (remove persona), real-user identity, real org fetch + consumption, empty feed (no seeds). Out of scope (separate later plans): deleting the now-dead Slack-Classic / camera / `DemoData.swift` files (Phase 4C scope-trim), and the in-app Japanese language toggle (Phase 5). During this plan `DemoData.swift` may remain present but is no longer used for identity/org.

## Key facts (verified against the code)

- `AppConfig.relayURL` default is `ws://127.0.0.1:8080`; override precedence (launch arg `-RelayURL`, then Info.plist `RelayURL`) is kept. `AppConfig.defaultUser = DemoUser.toru.user`.
- `AppState.backendBaseURL = BackendURL.httpBase(from: relayURL)` → `https://…` for a `wss://` relay. `AIService.configure(backendBaseURL:)` and `routeInstruction` post to `/ai/route`; `refreshAvailability` reads `/health`.
- `GitHubService.exchangeCode` reads only `accessToken` from `/oauth/github/token`; the response also includes `sessionToken` (Phase 1). `selectRepository` fetches `/user` → `username` (the login) and saves a `GitHubConnection{username, repository /*owner/repo*/, repositoryURL}` via `SessionStore.saveGitHubConnection`.
- `SessionStore` persists `githubToken, githubRepository, githubUsername, githubRepositoryURL, currentUserID` in the keychain. No `sessionToken` slot yet.
- `WebSocketService.connect(urlString:userId:orgId:)` sends `join {userId, orgId, protocol:"agui/1"}` — no `sessionToken`, `orgId` defaults to `"core-team"`.
- `FeedViewModel.draftInstruction` and `OrgGraphView` use `DemoData.organization`; `AIService.routeInstruction` derives the recipient name via `DemoData.userName(for:)`.
- `User = {id, name, role, teamID?, githubUsername?}`, `agentID = "agent-\(id)"`. `OrganizationGraph = {nodes:[OrgNode{id,kind,label}], edges:[OrgEdge{id,fromID,toID,kind}]}`.
- Onboarding steps: `welcome, routing, swipe, github, persona`. `enter(_ demoUser:)` calls `appState.activateSession(as: demoUser.user)`.

---

## Task 1: Point the app at the deployed backend

**Files:**
- Modify: `TikTokForWork/App/AppConfig.swift`

- [ ] **Step 1: Change the default relay URL**

In `AppConfig.relayURL`, change the final fallback `return "ws://127.0.0.1:8080"` to the deployed Worker:

```swift
        return "wss://tiktokforwork.torubj0904.workers.dev"
```

Leave the launch-arg and Info.plist override branches unchanged (dev can still point elsewhere with `-RelayURL`).

- [ ] **Step 2: Build**

Run the build command from the Verification model.
Expected: `** BUILD SUCCEEDED **`.

- [ ] **Step 3: Commit**

```bash
git add TikTokForWork/App/AppConfig.swift
git commit -m "feat(ios): default to the deployed Cloudflare backend"
```

---

## Task 2: Capture & persist the app session token

**Files:**
- Modify: `TikTokForWork/Services/SessionStore.swift`
- Modify: `TikTokForWork/Services/GitHubService.swift`

- [ ] **Step 1: Add a `sessionToken` slot to `SessionStore`**

In the `Key` enum add `static let sessionToken = "sessionToken"`. Add a stored property mirroring the other keychain accessors:

```swift
    static var sessionToken: String? {
        get { read(Key.sessionToken) }
        set { write(Key.sessionToken, newValue) }
    }
```

(Use whatever the existing `read`/`write` keychain helpers are named — match `githubToken`'s getter/setter exactly.) Also clear it in `SessionStore.clear()` (add `write(Key.sessionToken, nil)` alongside the other keys).

- [ ] **Step 2: Capture the sessionToken in `exchangeCode`**

In `GitHubService.exchangeCode(_:backendBaseURL:)`, after decoding `accessToken`, also read the optional `sessionToken` and persist it:

```swift
        if let session = json["sessionToken"] as? String, !session.isEmpty {
            SessionStore.sessionToken = session
        }
        return accessToken
```

(Insert immediately before the existing `return accessToken`. The `json` dictionary is already parsed in that method.)

- [ ] **Step 3: Build**

Run the build command. Expected: `** BUILD SUCCEEDED **`.

- [ ] **Step 4: Commit**

```bash
git add TikTokForWork/Services/SessionStore.swift TikTokForWork/Services/GitHubService.swift
git commit -m "feat(ios): persist the app session token from OAuth"
```

---

## Task 3: Real authenticated user from the GitHub connection

**Files:**
- Modify: `TikTokForWork/App/AppState.swift`

The signed-in user must be the real GitHub user, with `User.id == login` (the backend's member id). The `GitHubConnection` produced by `selectRepository` carries `username` (login).

- [ ] **Step 1: Add a helper that builds the real user and a GitHub-session activation path**

In `AppState`, add:

```swift
    /// Build the app user from a GitHub connection. The id is the GitHub login,
    /// matching the backend's org member ids.
    static func user(from connection: GitHubConnection) -> User {
        User(
            id: connection.username,
            name: connection.username,
            role: "Member",
            teamID: connection.repository,
            githubUsername: connection.username
        )
    }

    /// Activate a session for the signed-in GitHub user and connect the relay
    /// with the session token, keyed to the repo org.
    func activateGitHubSession(connection: GitHubConnection) async {
        let user = AppState.user(from: connection)
        SessionStore.currentUserID = user.id
        cardService.setActiveUser(user.id)
        let orgId = connection.repository            // "owner/repo"
        do {
            try await webSocketService.connect(
                urlString: relayURL,
                userId: user.id,
                orgId: orgId,
                sessionToken: SessionStore.sessionToken
            )
        } catch {
            // Relay unreachable: still let the user in; the feed will be empty.
        }
        currentUser = user
        isAuthenticated = true
        await loadOrganization(owner: orgOwner(orgId), repo: orgRepo(orgId))
    }

    private func orgOwner(_ full: String) -> String { full.split(separator: "/").first.map(String.init) ?? "" }
    private func orgRepo(_ full: String) -> String { full.split(separator: "/").dropFirst().first.map(String.init) ?? "" }
```

(`webSocketService.connect` gains a `sessionToken` parameter in Task 5, and `loadOrganization` is added in Task 6 — this file will not build in isolation until those land; that is expected for a multi-file feature. Build verification for this task happens after Task 6. To keep intermediate commits green, implement Tasks 3–6 as one unit and run the build once at the end of Task 6. Commit Task 3's diff now regardless.)

- [ ] **Step 2: Rework session restore to require a real GitHub session**

Replace the body of `restoreSessionIfNeeded()` so it no longer falls back to a persona/`DemoData.user`:

```swift
    func restoreSessionIfNeeded() async {
        guard SessionStore.hasSavedGitHubSession,
              githubService.restoreSavedSession(),
              let connection = githubService.connection else {
            return // not signed in → RootView shows onboarding
        }
        do {
            try await githubService.validateSavedSession()
        } catch {
            githubService.disconnect()
            SessionStore.clear()
            return
        }
        await activateGitHubSession(connection: connection)
    }
```

- [ ] **Step 3: Retire the persona `activateSession` default**

Remove the `activateSession(as:)` method's reliance on `AppConfig.defaultUser`/`DemoData` (it is replaced by `activateGitHubSession`). If any code still calls `activateSession(as:)`, it will be migrated in Task 4. Leave a thin wrapper only if the compiler needs it; prefer deleting the method and fixing callers in Task 4.

- [ ] **Step 4: Commit (build deferred to Task 6)**

```bash
git add TikTokForWork/App/AppState.swift
git commit -m "feat(ios): authenticated user is the real GitHub login"
```

---

## Task 4: Auth-first onboarding (remove the persona step)

**Files:**
- Modify: `TikTokForWork/Features/Onboarding/OnboardingView.swift`

- [ ] **Step 1: Drop the `persona` step and make GitHub sign-in the finish line**

In the `Step` enum remove `case persona`, so it is `welcome, routing, swipe, github`. Delete `personaStep`, `personaRow`, and `enter(_ demoUser:)`.

- [ ] **Step 2: On successful GitHub sign-in + repo pick, activate the real session**

In the GitHub step, after `signInWithOAuth` succeeds and the user picks a repository (the existing repo-picker calls `githubService.selectRepository(...)` which returns a `GitHubConnection`), activate the session and let `RootView` switch to the feed:

```swift
        let connection = try await appState.githubService.selectRepository(repo.fullName)
        await appState.activateGitHubSession(connection: connection)
```

(Wire this into the existing repo-selection button/handler in the github step. Remove any "skip / continue as persona" affordance — GitHub sign-in + repo pick is now required to enter. Keep a clear error state if OAuth or repo fetch fails.)

- [ ] **Step 3: Update copy**

Change the github step's subtitle to reflect that it is required, e.g. "Sign in with GitHub to reach your team. Your teammates are your repo's collaborators." Remove references to skipping.

- [ ] **Step 4: Commit (build deferred to Task 6)**

```bash
git add TikTokForWork/Features/Onboarding/OnboardingView.swift
git commit -m "feat(ios): auth-first onboarding, GitHub sign-in required"
```

---

## Task 5: WebSocket join carries the session token

**Files:**
- Modify: `TikTokForWork/Services/WebSocketService.swift`

- [ ] **Step 1: Add `sessionToken` to `connect` and the join envelope**

Change the signature:

```swift
    func connect(urlString: String, userId: String, orgId: String = "core-team", sessionToken: String? = nil) async throws {
```

Store it (`private var lastSessionToken: String?`) alongside `lastUserID`/`lastOrgID`, set it at the top of `connect`, and use it when sending join and on reconnect. Change the join case of `OutboundEvent` to include it:

```swift
    enum OutboundEvent {
        case join(userId: String, orgId: String, sessionToken: String?)
        // …other cases unchanged…

        var envelope: [String: Any] {
            switch self {
            case .join(let userId, let orgId, let sessionToken):
                var payload: [String: Any] = [
                    "userId": userId,
                    "orgId": orgId,
                    "protocol": AGUIProtocol.version,
                ]
                if let sessionToken, !sessionToken.isEmpty { payload["sessionToken"] = sessionToken }
                return ["type": "join", "payload": payload]
            // …
            }
        }
    }
```

Update the `send(.join(...))` call in `connect` (and the reconnect path, which uses `lastUserID`/`lastOrgID`) to pass `sessionToken: lastSessionToken`.

- [ ] **Step 2: Commit (build deferred to Task 6)**

```bash
git add TikTokForWork/Services/WebSocketService.swift
git commit -m "feat(ios): send session token on relay join"
```

---

## Task 6: Fetch and use the real org graph

**Files:**
- Modify: `TikTokForWork/App/AppState.swift`
- Modify: `TikTokForWork/ViewModels/FeedViewModel.swift`
- Modify: `TikTokForWork/Services/AIService.swift`
- Modify: `TikTokForWork/Features/Org/OrgGraphView.swift`

- [ ] **Step 1: Add `organization` state + a loader to `AppState`**

Add a published property and a fetch that calls the backend org endpoint with the session token:

```swift
    @Published var organization = OrganizationGraph(nodes: [], edges: [])

    func loadOrganization(owner: String, repo: String) async {
        guard !owner.isEmpty, !repo.isEmpty,
              let base = backendBaseURL,
              let token = SessionStore.sessionToken,
              let url = URL(string: "orgs/\(owner)/\(repo)/graph", relativeTo: base) else { return }
        var request = URLRequest(url: url)
        request.setValue(token, forHTTPHeaderField: "x-session-token")
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else { return }
            organization = try JSONDecoder().decode(OrganizationGraph.self, from: data)
        } catch {
            // leave organization empty; the feed still works, routing falls back
        }
    }
```

- [ ] **Step 2: Feed uses the real org**

In `FeedViewModel.draftInstruction`, replace `organization: DemoData.organization` with the live org threaded from `appState`:

```swift
            return try await appState.aiService.draftInstruction(
                text: text,
                sender: user,
                organization: appState.organization,
                priorityOverride: priority
            )
```

- [ ] **Step 3: `AIService` derives the recipient name from the org, not DemoData**

In `AIService.routeInstruction`, replace `let recipientName = DemoData.userName(for: routingResponse.recipientUserID)` with an org-derived name helper. Add a private helper to `AIService`:

```swift
    private func name(for userID: String, in organization: OrganizationGraph) -> String {
        if let node = organization.nodes.first(where: { $0.id == userID && $0.kind == .person }) {
            return node.label.split(separator: "·").first.map { $0.trimmingCharacters(in: .whitespaces) } ?? userID
        }
        return userID
    }
```

and use `let recipientName = name(for: routingResponse.recipientUserID, in: organization)`.

- [ ] **Step 4: Org view renders the real org**

In `OrgGraphView`, replace the `private let graph = DemoData.organization` with the app's live org:

```swift
    @EnvironmentObject private var appState: AppState
    private var graph: OrganizationGraph { appState.organization }
```

(Adjust the view body to read `graph` as a computed property. If `OrgGraphView` is presented somewhere without `AppState` in the environment, pass it in.)

- [ ] **Step 5: Build the whole Tasks 3–6 unit**

Run the build command.
Expected: `** BUILD SUCCEEDED **`. Fix any compile errors from the multi-file rework (missing `sessionToken` arg, `loadOrganization` reference, `activateSession` callers) until green.

- [ ] **Step 6: Commit**

```bash
git add TikTokForWork/App/AppState.swift TikTokForWork/ViewModels/FeedViewModel.swift TikTokForWork/Services/AIService.swift TikTokForWork/Features/Org/OrgGraphView.swift
git commit -m "feat(ios): consume the real org graph from the backend"
```

---

## Task 7: Empty feed — no seeded cards

**Files:**
- Modify: `TikTokForWork/Services/DecisionCardService.swift`
- Modify: `TikTokForWork/ViewModels/FeedViewModel.swift`

- [ ] **Step 1: Stop seeding the demo feed**

In `DecisionCardService`, make `seedDemoFeedIfNeeded()` a no-op (delete its body, or delete the method and its call sites in `applySnapshot`). Remove the `FirstRunFlags.seededFeed` write. The store now starts empty and fills only from real relay events.

- [ ] **Step 2: Real empty state in the feed**

In `FeedViewModel.bind`, remove the `isTriaging` seeding path. When `cards.isEmpty`, the feed should show a calm empty state. Add/point to an empty-state view with copy: "No decisions yet. Tell your AI something, or wait for a teammate." (Use `String(localized:)` so Phase 5 can translate it.)

- [ ] **Step 3: Build**

Run the build command. Expected: `** BUILD SUCCEEDED **`.

- [ ] **Step 4: Commit**

```bash
git add TikTokForWork/Services/DecisionCardService.swift TikTokForWork/ViewModels/FeedViewModel.swift
git commit -m "feat(ios): empty feed on real data, no demo seeds"
```

---

## Task 8: Full build + manual simulator smoke

**Files:** none (verification)

- [ ] **Step 1: Clean build**

Run:
```bash
cd /Users/torutano/HonmaruAI && xcodegen generate && \
xcodebuild -project TikTokForWork.xcodeproj -scheme TikTokForWork \
  -destination 'generic/platform=iOS Simulator' -configuration Debug build
```
Expected: `** BUILD SUCCEEDED **`.

- [ ] **Step 2: Manual simulator checklist (run by the user)**

These require a booted simulator/device and a real GitHub login, so they are performed manually:

1. Launch the app → onboarding ends at **Sign in with GitHub** (no persona step).
2. Complete GitHub OAuth → the repo picker lists your repositories → pick one.
3. The feed opens **empty** ("No decisions yet…") — no seeded cards.
4. Open the org view → it shows the **repo's real collaborators** (person + agent nodes), not Toru/Tanaka/Yui/Alex.
5. Tell your AI: "ask <a real collaborator's login> to review X" → a Decision Card is routed; on a second device signed in as that collaborator, the card appears; deciding reflects back.
6. Kill and relaunch → session restores straight to the feed (no re-login), because the saved GitHub session + `sessionToken` are restored.

- [ ] **Step 3: Record results**

Note any checklist failures as follow-up issues. A green build plus items 1–4 passing is the bar for Phase 4; items 5–6 exercise the end-to-end multi-user path and may need the two-device setup.

---

## Self-Review Notes (addressed)

- **Spec coverage (Phase 4):** deployed-backend connection (Task 1), sessionToken plumbing (Tasks 2/5/6), auth-first with real GitHub identity and no persona (Tasks 3/4), real org fetch + use in routing and the org view (Task 6), and empty feed without seeds (Task 7). Manual checklist verifies end-to-end (Task 8).
- **Member-id consistency:** `User.id = GitHub login`, the org nodes use logins, `/ai/route` sender + recipient and the relay `userId` all use logins — matching Phase 2/3 backend conventions.
- **Build-based verification:** no test target exists, so each task builds via `xcodebuild`; Tasks 3–6 are a single multi-file unit built once at the end of Task 6 (intermediate commits will not individually compile — this is called out in Task 3).
- **Deferred:** deleting the now-unused Slack-Classic/camera files and `DemoData.swift` (Phase 4C scope-trim), and the in-app Japanese toggle (Phase 5). `DemoData.swift` remains in the target during Phase 4 but is no longer referenced for identity/org (confirm no remaining references at Task 6 build; `DemoData.userName`/`.organization`/`.user` calls are all replaced).
- **Risk:** the org-view environment object — if `OrgGraphView` is constructed without `AppState` in its environment, Task 6 Step 4 must inject it; the build will surface this.
```
