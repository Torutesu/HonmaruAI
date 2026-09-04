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
// A decision Bob made on Alice's request is Bob's audit trail as much as it is
// Alice's. Erasing it would rewrite his history, and the export a team relies on
// for "who approved this?" would silently develop holes. So card_events survive
// with their actor anonymized — and the privacy policy says so, because an
// undisclosed retention is a worse answer than a disclosed one.

const ANONYMOUS = "deleted-user";

export async function deleteAccount(db, githubId, login) {
  const id = String(githubId);

  // Cards addressed to this person, and the ones they sent that nobody has
  // acted on, are theirs. Cards they sent that someone else already holds stay
  // with that person — the sender's name comes off instead.
  //
  // Off the *row and the JSON inside it*. Every client reads the card out of
  // `data` and the event out of `snapshot`; the columns beside them are there
  // for querying. Anonymizing only the columns left the person's login in every
  // teammate's feed and every line of the history, and the test that guarded
  // this asserted on the columns, so it passed while the name stayed put.
  if (login) {
    await db.prepare("DELETE FROM cards WHERE recipient_user_id = ?1").bind(login).run();
    await db
      .prepare(
        `UPDATE cards
            SET sender_user_id = ?1,
                data = json_set(data, '$.senderUserID', ?1)
          WHERE sender_user_id = ?2`
      )
      .bind(ANONYMOUS, login)
      .run();
    // A hand-on names whoever asked first, all the way down the chain.
    await db
      .prepare(
        `UPDATE cards
            SET data = json_set(data, '$.originSenderUserID', ?1)
          WHERE json_extract(data, '$.originSenderUserID') = ?2`
      )
      .bind(ANONYMOUS, login)
      .run();
    await db.prepare("DELETE FROM contexts WHERE user_id = ?1").bind(login).run();
    await db
      .prepare(
        `UPDATE card_events
            SET actor_user_id = ?1,
                snapshot = json_set(snapshot, '$.decision.actorUserID', ?1)
          WHERE actor_user_id = ?2 AND json_extract(snapshot, '$.decision.actorUserID') = ?2`
      )
      .bind(ANONYMOUS, login)
      .run();
    await db
      .prepare("UPDATE card_events SET actor_user_id = ?1 WHERE actor_user_id = ?2")
      .bind(ANONYMOUS, login)
      .run();
    for (const field of ["senderUserID", "recipientUserID", "originSenderUserID"]) {
      await db
        .prepare(
          `UPDATE card_events
              SET snapshot = json_set(snapshot, '$.${field}', ?1)
            WHERE json_extract(snapshot, '$.${field}') = ?2`
        )
        .bind(ANONYMOUS, login)
        .run();
    }
    // Someone who reported to them now reports to nobody. A dangling name here
    // would keep routing escalations at a person who has left.
    await db
      .prepare("UPDATE org_profiles SET manager_login = NULL WHERE manager_login = ?1")
      .bind(login)
      .run();
    await db.prepare("DELETE FROM device_tokens WHERE login = ?1").bind(login).run();
  }

  for (const sql of [
    "DELETE FROM sessions WHERE github_id = ?1",
    "DELETE FROM memberships WHERE user_github_id = ?1",
    "DELETE FROM org_profiles WHERE user_github_id = ?1",
    "DELETE FROM agents WHERE user_github_id = ?1",
    "DELETE FROM connector_config WHERE user_github_id = ?1",
    "DELETE FROM entitlements WHERE user_github_id = ?1",
    "DELETE FROM ai_usage WHERE user_github_id = ?1",
    "DELETE FROM ingested_items WHERE user_github_id = ?1",
    "DELETE FROM device_tokens WHERE user_github_id = ?1",
    "DELETE FROM users WHERE github_id = ?1",
  ]) {
    try {
      await db.prepare(sql).bind(id).run();
    } catch (err) {
      // device_tokens may not exist on a database that predates push. A missing
      // table must not leave the account half-deleted.
      if (!/no such table/i.test(String(err?.message))) throw err;
    }
  }
}
