# The improvement loop

How the product gets better from being used, and where each piece lives.

```
 a person flags a card ──► card_feedback ──► Insights (You → Insights)
        │                        │
        │                        └──► GET /eval/export ──► eval/golden.json ──► npm run eval
        │                                                                          │
        └──────────── the router reads load + recent decisions ◄───── prompt changes, gated in CI
```

## 1. Say what was wrong

Under every card in the web feed: **Is this card wrong?** → one of *Wrong
person · Not a decision · Wrong priority · Badly written*. That is
`POST /cards/:id/feedback` with `{ orgId, verdict: "wrong", reason }`. Only
the card's sender or recipient can rate it; one verdict per person per card,
the latest standing. It is also written to the card's timeline as a
`feedback` event, so it shows in `GET /orgs/:o/:r/events`.

## 2. See the numbers

**You → Insights** reads `GET /metrics?orgId=…&days=7|14|30`:

| Number | Meaning |
|--------|---------|
| cards | created in the window |
| median wait | minutes from a card's creation to its decision, median |
| declined | declines over all decisions |
| pending / decided / nudged | as named; a nudge is a decision that had to be asked about twice |
| by source | You (told your AI), Gmail, Slack, … |
| by action | approve / decline / reply / … |
| what your AI got wrong | flag reasons, counted |

Everything is computed from `cards`, `card_events` and `card_feedback` at
request time. There is no counter to drift.

## 3. Measure the router

```bash
cd worker
npm run eval                # the local keyword router, no key needed
npm run eval:model          # plus the model, with OPENAI_API_KEY (OPENAI_MODEL to choose)
node eval/run.mjs --gate 0.9 eval/golden.json eval/from-prod.json
```

`eval/golden.json` holds org fixtures and entries: an instruction, its
sender, and what a person would call right. Recipient accuracy is the number
that matters and is gated in CI (`test/eval-golden.test.js`, 90%); type,
priority and business are reported.

To grow the set from real use: `GET /eval/export?orgId=…` returns the org's
cards in golden shape, with each person's verdict attached. A card flagged
*wrong person* comes back with `expect.recipientUserID: null` — a question
for whoever curates the set — and the rest as it was. Save the entries you
have confirmed into a second file and pass both to the runner.

## 4. Give the router more to work with

`/ai/route` now hands the model two bounded lists alongside the org:

- **Current load** — for each member with pending cards, how many and how
  old the oldest is.
- **Recent decisions** — the team's last twelve, one line each, with the
  reply or note if there was one.

`SYSTEM_PROMPT` tells the model what they are for: between two people who fit
equally, prefer the less loaded one and say so; and lean a recommendation on a
real recent decision rather than the instruction alone. Both lists are absent
on a fresh workspace, so its prompt is unchanged.

## What to do with a week of use

1. Look at Insights. If median wait is long, the feed is not reaching people
   (notifications) or cards are unclear (badly written flags). If decline
   rate is high, the router is asking the wrong questions.
2. Export the flagged cards, confirm the expectation on each, add them to the
   golden set.
3. Change the prompt or the router; run `npm run eval:model`; keep the change
   only if the number moved the right way.
