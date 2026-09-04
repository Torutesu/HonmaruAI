/* A decision could be overwritten by a stale copy of itself.

   Every write to a card is a read, a merge in JavaScript, and a write back,
   with two awaits on D1 in between — and a Durable Object releases its input
   gate across an external storage await. So two sockets belonging to the same
   person (a phone and an iPad, or the same phone reconnecting mid-decision)
   could both read the pending card, both merge their own change onto it, and
   both write. The second write won, silently, and the first decision was gone
   with no error anywhere.

   The worst case was not two devices. The recipient's AI rewrites an incoming
   card in the background: it re-reads the card to check nobody has answered
   yet, and then writes. A decision made in that window was overwritten by a
   rewrite of the question.

   `version` makes the write conditional on the read still being current. */
ALTER TABLE cards ADD COLUMN version INTEGER NOT NULL DEFAULT 0;
