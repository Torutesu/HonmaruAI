# HonmaruAI — What I Did

## The short version

HonmaruAI worked only on iOS, and only for people with a GitHub account
who had write-access to a repo. That locked out designers, PMs, and anyone
without those things — exactly the people who'd want to try it.

I made it work in a browser, for anyone, with a simple email login. So now
a person can open a link, sign up with an email, and actually use HonmaruAI:
type an instruction, watch it become a decision card, and approve or decline it.

It went from "iPhone-only demo" to "anyone can use it in a browser."

---

## What I understood first (before changing anything)

I read the whole repo before touching it. A few things stood out:

- It's further along than an "MVP" — it already had 197 passing backend
  tests, CI, a deployed backend, and a security hardening pass.
- The only real way to use it was the iOS app. There was a web client in the
  repo, but it was a "reference" toy — you typed a username in a box, and it
  could only reach a fake demo org. It couldn't sign in or reach a real team.
- Membership required GitHub write-access, so non-engineers couldn't get in.

So the biggest gap wasn't "make it prettier" — it was "nobody outside iOS can
actually use this." That became my focus.

## What I built

**1. A real login for the web (email + password, no GitHub)**
Anyone can sign up and log in with an email. Passwords are hashed (not stored
in plain text). This is the main unlock — it's what lets non-GitHub people use
the product at all. Kept it simple on purpose, per direction.

**2. The full decision loop in the browser**
Type an instruction → it gets routed into a Decision Card → it shows up in the
feed → approve / decline / acknowledge → it's recorded. The whole core
experience, working on the web.

**3. Team invites**
A member creates a shareable invite code; anyone who signs up with it joins that
team. Before this, teams could only be joined by hand-editing the database — so
now a real team can onboard itself.

**4. Real routing to the right teammate**
Instructions like "ask Newbie to review this" now actually route to Newbie and
land in their feed in real time. The backend builds the team from real
memberships (so it can't be faked by the client) and matches the named person.
This is the core promise of the product — tell your AI, it reaches the right
person — working between real people in a browser.

## Problems I found and fixed along the way

I found these by actually running the product, not just reading code:

- **A security issue:** the live backend was accepting connections without any
  sign-in — anyone who knew an org name could read that team's cards. I flagged
  it with proof rather than trying to fix production myself.
- **The web client lied about being connected:** it showed "Connected" the
  moment the socket opened, before the server had accepted it — so it showed a
  green badge (and stale cards) over a dead session. Fixed it to only say
  connected once the server really accepts you.
- **It ignored which team you picked:** the org you chose never reached the
  server, so everyone silently landed in the demo org. Fixed.
- **The backend couldn't be called from any browser** (no CORS headers). Native
  apps don't hit this, so it only showed up on the web. Fixed.
- **It hammered the server on a dropped connection** — retrying every 2 seconds
  forever. Added backoff (2s → 4s → 8s, capped) that resets on reconnect.
- **Cards showed raw ids** like "Update for email:kinjal@test.com". Now they
  show a friendly name ("Update for Kinjal").

## How I tested it

I used it like a real teammate and tried to break it:
- Empty input → correctly refused
- Very long text → handled, truncated cleanly
- Script injection (`<script>`) → safely shown as text, no XSS
- Two users, two browser tabs → a decision created by one person shows up in
  the other person's feed live
- Wrong password → correctly rejected
- All 197 backend tests pass, and CI is green.

I kept a short dogfooding log of these in `DOGFOODING.md`.

## What's still left (and why)

- **Deploy it publicly** so the team can reach it (it's on localhost now). Needs
  hosting access.
- **Invite teammates to a team** — right now people are added manually. This is
  the next thing I'd build for real team use.
- **Stronger auth later** — kept it simple for now, per direction; proper token
  handling is a "later" step.

## How to try it locally

1. `cd worker && npx wrangler dev --local --port 8787`
2. `cd web-react && npm run dev`
3. Open the web client → Sign up with any email → you're in the feed
4. Type an instruction → a card appears → approve or decline it

All the work is in PR #10.