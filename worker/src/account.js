// Deleting an account.
//
// Apple requires this in-app for anything that lets you create an account
// (Guideline 5.1.1(v)), and it is the only erasure path we have under GDPR/APPI.
// It is also the operation most likely to be got subtly wrong, so the rule it
// follows is written down rather than inferred from the SQL:
//
//   Anything that is *about* this person goes.
//   Anything that is *someone else's record of a shared event* stays, with the
//   person's name taken off it.
//
// A rule is only as good as the list it is applied to. Three tables were named
// by neither half of it and so by nothing: `invites`, which left a live way
// into the organization minted by an account that no longer exists;
// `businesses.created_by`, which is the organization's record and needed the
// second half rather than the first; and `login_codes`, which is keyed by the
// address instead of the account and so was invisible to every query here.
//
// A decision Bob made on Alice's request is Bob's audit trail as much as it is
// Alice's. Erasing it would rewrite his history, and the export a team relies on
// for "who approved this?" would silently develop holes. So card_events survive
// with their actor anonymized — and the privacy policy says so, because an
// undisclosed retention is a worse answer than a disclosed one.

const ANONYMOUS = "deleted-user";

export async function deleteAccount(db, githubId, login) {
  const id = String(githubId);

  // Read before the users row goes: `login_codes` is keyed by the address, not
  // by the account, so this is the only thing that still knows the two are the
  // same person.
  const account = await db
    .prepare("SELECT email FROM users WHERE github_id = ?1")
    .bind(id)
    .first();

  // A credential this person minted. Not somebody else's record of anything —
  // it is an unredeemed way into the organization with up to seven days left
  // on it, and the account that vouched for it no longer exists. It also put
  // the address back on the team screen: `listInvites` falls back to
  // `created_by` for a creator whose users row has been deleted.
  await db.prepare("DELETE FROM invites WHERE created_by = ?1").bind(id).run();

  // A business is the organization's record of what it does, so it stays — on
  // the same rule as card_events, and with the same treatment: the name comes
  // off. `listBusinesses` hands `createdBy` to every member.
  await db
    .prepare("UPDATE businesses SET created_by = ?1 WHERE created_by = ?2")
    .bind(ANONYMOUS, id)
    .run();

  // Cards addressed to this person, and the ones they sent that nobody has
  // acted on, are theirs. Cards they sent that someone else already holds stay
  // with that person — the sender's name comes off instead.
  if (login) {
    await db.prepare("DELETE FROM cards WHERE recipient_user_id = ?1").bind(login).run();
    await db
      .prepare("UPDATE cards SET sender_user_id = ?1 WHERE sender_user_id = ?2")
      .bind(ANONYMOUS, login)
      .run();
    await db.prepare("DELETE FROM contexts WHERE user_id = ?1").bind(login).run();
    await db
      .prepare("UPDATE card_events SET actor_user_id = ?1 WHERE actor_user_id = ?2")
      .bind(ANONYMOUS, login)
      .run();
  }

  // An outstanding sign-in code for this address. Ten minutes of life left and
  // a hash rather than the code, but it is a row that says this person was
  // here, and it survives the account it belongs to.
  if (account?.email) {
    await db.prepare("DELETE FROM login_codes WHERE email = ?1").bind(account.email).run();
  }

  for (const sql of [
    "DELETE FROM sessions WHERE github_id = ?1",
    "DELETE FROM memberships WHERE user_github_id = ?1",
    "DELETE FROM agents WHERE user_github_id = ?1",
    "DELETE FROM connector_config WHERE user_github_id = ?1",
    "DELETE FROM entitlements WHERE user_github_id = ?1",
    "DELETE FROM ai_usage WHERE user_github_id = ?1",
    "DELETE FROM ingested_items WHERE user_github_id = ?1",
    "DELETE FROM device_tokens WHERE user_github_id = ?1",
    "DELETE FROM push_subscriptions WHERE user_github_id = ?1",
    "DELETE FROM users WHERE github_id = ?1",
  ]) {
    try {
      await db.prepare(sql).bind(id).run();
    } catch (err) {
      // device_tokens or push_subscriptions may not exist on a database that predates push. A missing
      // table must not leave the account half-deleted.
      if (!/no such table/i.test(String(err?.message))) throw err;
    }
  }
}
