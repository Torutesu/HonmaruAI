# Businesses

Ten people running ten businesses. Every card belongs to one, and nobody
files anything by hand: the AI reads each card and puts it under the
business it is about, in the background, creating the business when the name
is new. The taxonomy is the residue of use — it is never set up first, and
there is no chip row, folder or filter to maintain.

## What the person sees

A small label on the card (`CAFE SAKURA`, `HOTEL 本丸`) next to its kind, and
the list of businesses the AI has filed things under, in the **⋯** sheet.
That is all. The feed is one decision after another, most urgent first.

## How a card gets a business

Every path that creates a card files it. All of them use `classify.js`,
one short model call paid from the same allowance as the routing or triage
that produced the card, and all of them skip when there is no model:

1. **The router** (`/ai/route`). The org's businesses go to the model as an
   enum on `create_decision_card`, plus a `newBusiness` field for when none
   fits. An existing slug wins; an invented one is dropped in favour of the
   instruction's own words (each business's name and its distinctive words,
   in any script — `本丸の予約` is Hotel 本丸); failing that, the new name
   the model proposed.
2. **The relay**, on `card_created` for a card that arrives without one —
   the iOS app, an older client, a card the router could not place. Filed in
   the same deferred step as the translation into the recipient's language,
   then saved and re-broadcast, so every device shows the label.
3. **Connector sync** and the **email webhook**: a triaged message is filed
   before it is saved.

The model prefers an existing business whenever the card plausibly concerns
it, names a new one only when nothing fits (1–3 words, the venture itself,
in the card's language), and puts company-wide matters under "General".

## Model

| Where | What |
|-------|------|
| `businesses` table | `(org_id, slug, name, created_by, created_at)`. The slug is the name lowercased with punctuation folded to `-`, letters of any script kept: `Hotel 本丸` → `hotel-本丸`. The first spelling of a name sticks |
| `cards.data.business` | the slug, or absent until the background filing lands |
| `card_events` | a re-filing is a `filed` event carrying the slug as its action |

## API (kept for tooling; no client offers it as UI)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/businesses?orgId=` | the org's businesses (member) — the web client reads it to turn a slug into a name |
| POST | `/businesses` | `{ orgId, name }` (member) |
| DELETE | `/businesses` | `{ orgId, slug }` — removes the row; cards keep their tag (member) |
| WS | `set_business` | `{ cardId, business \| null }` — sender or recipient may re-file |

## Tests

`worker/test/classify.test.js` — the model's pick by slug or by name; a new
name becoming a business and the card getting its slug; nothing happening
without a model, an allowance, or a useful answer; the router proposing a new
name. `worker/test/businesses.test.js` — slugs, the routes, filing from a
card, re-filing by either party, the router never inventing a slug.
