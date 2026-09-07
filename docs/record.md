# The record

The minimum documentation a team of ten running ten businesses needs is an
answer to "what did we decide about the hotel, and when?". Nobody should
have to write that down; the cards already know. The record is a view over
them: per business, what was decided (by whom, when, with what note), and
what is still open. It is never stale, because nothing is stored.

## Where

- **Web**: ⋯ → **The record**. Sections per business, in the reader's
  language, with **Copy as Markdown** for pasting into Notion, a README or
  a message.
- **API**: `GET /record?orgId=` (member) returns JSON; `&format=md` returns
  `text/markdown`. `&locale=ja` overrides the reader's stored locale.
- **Notion**: a decision still lands as a row in the decider's chosen Notion
  database the moment it is made (`notionWriter.js`), now with the business
  on it. The record is the whole picture; the row is the event.

## Shape

```
{ orgId, generatedAt, businesses: [
  { slug, name, open: [ { id, title, recipient, createdAt, … } ],
                decided: [ { id, title, action, actionLabel, actor, decidedAt, note, … } ] } ] }
```

Named businesses first, most recently decided first; cards the AI has not
filed yet last, under no name. Titles come from `localized[locale]` when the
relay produced one, so a Japanese reader sees the Japanese card.

Source: `worker/src/record.js`. Tests: `worker/test/record.test.js`.
