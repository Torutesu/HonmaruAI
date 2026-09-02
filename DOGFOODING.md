# HonmaruAI Web Client — Dogfooding Log

Using the web client like a real teammate, trying to break it, recording what I find.

Format: Issue → Severity → Reproduce → Fix → Verified

---

## 1. Reconnect loop hammered the server — FIXED
- **Severity:** Medium
- **Reproduce (old):** Stop the backend → client retried every 2s forever, spamming the console.
- **Fix:** Exponential backoff (2s → 4s → 8s … capped at 30s), reset to 2s on a successful join.
- **Verified:** Yes ✓ — observed gaps growing (1s→5s→7s…) while down, instant reconnect when the server returned. 

## 2. Routing falls back to demo identities — RESOLVED
- **Severity:** High
- **Reproduce (old):** "deploy" routed to `user-alex` (a demo ghost) when the org
  was passed without real members.
- **Root cause:** the web client sent members under the wrong key, so the router
  saw an empty org and used demo fallback routes.
- **Fix:** CreateDecision now sends real members as `nodes`; the router's guard
  then correctly skips demo routes. Verified: "deploy staging" → routes to devuser.
- **Verified:** Yes ✓

## 3. Org resets to "core-team" on reload
- **Severity:** Low (already fixed)
- **Reproduce:** Was: reload page → org field reset to core-team.
- **Fix:** Persist orgId in localStorage.
- **Verified:** Yes ✓

## 4. Empty/whitespace input handled correctly
- **Severity:** N/A (works)
- **Reproduce:** Type only spaces → "Create decision" button is disabled, can't submit.
- **Fix:** Already correct (button disabled when text is empty after trim).
- **Verified:** Yes ✓

## 5. Long input handled gracefully
- **Severity:** N/A (works)
- **Reproduce:** Type a 300+ char instruction → card created, summary truncated with "..." cleanly, no layout break.
- **Verified:** Yes ✓

## 6. No XSS — special characters escaped safely
- **Severity:** N/A (works)
- **Reproduce:** Create a decision containing <script>alert(1)</script>. Renders as literal text, no code runs.
- **Verified:** Yes ✓ (React escapes by default)