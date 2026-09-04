/* Who a person is willing to be asked things by, over email.

   Inbound mail is the one connector where the sender is not a colleague and
   not authenticated. Gmail, Slack and Notion are read with the person's own
   OAuth grant, so what comes back is already theirs; an email webhook is a
   stranger with an address. Until now a stranger who knew someone's inbound
   address could put an approval card at the front of their feed, with a title
   and a priority of the stranger's choosing, and a push notification to match.

   A row here is an address this person has seen mail from. `trusted` is
   whether they have said it may raise a decision with them. Until it is set,
   mail from that address arrives as an update to read — never as something
   asking to be approved. */
CREATE TABLE IF NOT EXISTS email_senders (
  user_github_id TEXT NOT NULL,
  address        TEXT NOT NULL,
  trusted        INTEGER NOT NULL DEFAULT 0,
  first_seen_at  TEXT NOT NULL,
  last_seen_at   TEXT NOT NULL,
  PRIMARY KEY (user_github_id, address)
);
