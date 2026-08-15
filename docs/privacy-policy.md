# Privacy Policy — Honmaru AI

Last updated: 2026-08-15

Honmaru AI turns what you tell your AI into decisions routed to the right person
on your team. This page says exactly what that involves handling, why, where it
goes, and how to get rid of it.

We do not sell data, run advertising, or track you across other apps or
websites. There is no advertising SDK in the app and no third-party analytics.

---

## What we handle

| What | Why | Where it is stored |
|------|-----|--------------------|
| GitHub login, numeric id, avatar URL | This is your identity in the app; your repository's collaborators are your organization | Cloudflare D1 |
| GitHub access token | To read your repositories and collaborators, and to create the issues your approvals produce | Cloudflare D1, tied to your session |
| Decision cards — titles, summaries, context, notes | They are the product | Cloudflare D1 |
| The instructions you type or dictate | To route them to the right person | Sent to the model provider; the text of the instruction is stored on the card it produces |
| Video you attach to a decision | To show a teammate what you mean | Cloudflare R2 |
| Your context ("how I work") | So your AI routes the way you would | Cloudflare D1 |
| Connector settings (which Notion database, which accounts are linked) | So a sync knows where to read and write | Cloudflare D1; the connections themselves live at Composio |
| Daily AI call count | To meter the free tier | Cloudflare D1 |
| Subscription status | To know whether Pro is active | RevenueCat, keyed by your GitHub id |
| Device push token | To tell you a decision is waiting | Cloudflare D1 |

We do not collect location, contacts, health data, browsing history, or
advertising identifiers.

## Who else sees it

- **OpenAI** — the text of an instruction, and the sender/subject/preview of a
  message a connector is triaging, are sent to the model that turns them into a
  card. If you supply your own API key in the app, the request goes on your key
  and never touches ours.
- **GitHub** — the issue an approval creates, and the reads needed to build your
  organization graph.
- **Composio** — the intermediary that holds your Gmail, Slack and Notion
  connections. Each connection is authorized by you, per user, and can be
  revoked at Composio or by disconnecting in the app.
- **RevenueCat** — subscription state, keyed by your GitHub id.
- **Cloudflare** — hosting, storage, and the realtime relay.
- **Apple** — push notification delivery.

Nobody else. No data broker, no advertiser.

## Who inside your team sees it

Your organization is the collaborators on the GitHub repository you connect.
Everyone in it can see the decision cards in that organization — that is what
makes it a shared feed rather than four private inboxes. A decision is
attributed to whoever made it, and the history of what was decided is visible to
the team.

The relay refuses any connection that cannot prove write access to that
repository, and a card can only be decided by the person it was routed to.

## Audio and video

Dictation runs through Apple's speech recognition to turn what you say into an
instruction. Recorded video is uploaded only when you attach it to a decision,
and is served back from a random, unguessable URL.

## Retention

- Decision cards and their history are kept until deleted.
- Sessions expire after 30 days.
- Rate-limit counters are swept hourly; sign-in nonces expire in 10 minutes.
- Deleting your account removes everything listed under "What we handle", with
  the two exceptions below.

## Deleting your account

**Account → Delete account**, inside the app. It is immediate.

Two things survive, and it is worth being plain about why:

1. **A decision a teammate has not made yet** stays in their feed, with your
   name replaced by "deleted-user". Removing it would delete their pending work,
   not yours.
2. **The team's audit history** — what was decided, when — stays, with your name
   replaced by "deleted-user". It is the organization's record of what happened,
   and a record with holes in it is worse than no record.

Issues already created on GitHub are GitHub's; delete them there.

## Children

Honmaru AI is a workplace tool and is not directed at children under 13.

## Changes

Material changes will be announced in the app's release notes before they take
effect.

## Contact

Questions, or a data request that this page does not cover:
**support@honmaru.ai**
