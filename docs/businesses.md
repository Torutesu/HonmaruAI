# Businesses

Ten people running ten businesses. A card belongs to one of them, and the
feed is read one business at a time.

The taxonomy is **discovered, not designed**: there is no setup screen to fill
in before the product is usable. A business exists the moment someone names
it — in the chip row over the feed, in the picker when creating a decision,
or by filing any card under a name nobody has typed before. Re-filing a card
is one control on the card, and either party to the decision may do it.

## Model

| Where | What |
|-------|------|
| `businesses` table | `(org_id, slug, name, created_by, created_at)`. The slug is the name lowercased with punctuation folded to `-`, letters of any script kept: `Hotel 本丸` → `hotel-本丸`. The first spelling of a name is the one that sticks |
| `cards.data.business` | the slug, or absent. Validated to 64 characters |
| `card_events` | a re-filing is a `filed` event carrying the slug as its action, so the audit log answers "when did this move to the hotel?" |

## How a card gets a business

1. **The router.** `/ai/route` loads the org's businesses from the table and
   hands them to the model as an enum on `create_decision_card` — only when
   there are any, so the model is never invited to guess — and lists them in
   the prompt. A slug the model returns that is not one of ours is dropped.
   The keyword router, and the check on the model, match the instruction
   against each business's name and its distinctive words: `本丸の予約` files
   under Hotel 本丸.
2. **The sender.** The picker on the create form defaults to the chip the feed
   is filtered to, which is what a new decision is most likely about.
3. **Anyone party to the card.** `set_business { cardId, business }` over the
   relay, from the sender or the recipient. A name creates the business; `null`
   clears the tag.

## API

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/businesses?orgId=` | the org's businesses, in the order they were named (member) |
| POST | `/businesses` | `{ orgId, name }` → the business, and the list (member) |
| DELETE | `/businesses` | `{ orgId, slug }` — removes the chip; cards keep their tag (member) |
| WS | `set_business` | `{ cardId, business \| null }` — sender or recipient |

`orgId` is a query or body field rather than a path segment because a
personal org id is not `owner/repo`.

## Clients

- **Web**: a chip row over the feed (All · each business · Unfiled · +) that
  filters every section and remembers its choice; a business select on each
  card and each sent item; a picker on the create form.
- **iOS**: the card carries and shows the business as a chip in its header;
  the router's pick is stored on a card the app creates. A filter and a
  re-file control are not built yet.

## Tests

`worker/test/businesses.test.js`: slugs across scripts; the routes and who
may call them; filing from a card creating the business; re-filing and
clearing by either party, refused for a third; the router filing under one of
ours and never one it invented; `/ai/route` handing the table to the model.
