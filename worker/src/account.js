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

/// Everything this deployment holds about one person, in one document.
///
/// Deletion is half of what a person is owed under GDPR/APPI — the other half
/// is a copy. This is that copy: their profile, their cards, their history,
/// their settings. Someone else's record of a shared event stays theirs — a
/// decision Bob made on Alice's request is exported to Alice as the card, not
/// as Bob's row.
export async function exportAccount(db, githubId, login) {
  const id = String(githubId);
  const all = async (sql, ...binds) =>
    (await db.prepare(sql).bind(...binds).all()).results || [];
  // Tables that may not exist on a database that predates push: missing means
  // "no rows", which is also the honest answer.
  const tryAll = async (sql, ...binds) => {
    try {
      return await all(sql, ...binds);
    } catch (err) {
      if (/no such table/i.test(String(err?.message))) return [];
      throw err;
    }
  };

  const user = await db
    .prepare(
      "SELECT github_id, login, name, email, locale, notify_email, created_at FROM users WHERE github_id = ?1"
    )
    .bind(id)
    .first();

  const out = {
    exportedAt: new Date().toISOString(),
    user: user || null,
    memberships: await all(
      "SELECT org_id, role, title, created_at FROM memberships WHERE user_github_id = ?1", id
    ),
    // Cards are stored as JSON in `data`; the column fields are indexes over
    // it, so exporting the document exports the card.
    cardsAddressedToMe: login
      ? await all(
          "SELECT org_id, card_id, status, priority, created_at, decided_at, data FROM cards WHERE recipient_user_id = ?1",
          login
        )
      : [],
    cardsISent: login
      ? await all(
          "SELECT org_id, card_id, status, priority, created_at, decided_at, data FROM cards WHERE sender_user_id = ?1",
          login
        )
      : [],
    myActions: login
      ? await all(
          "SELECT org_id, card_id, type, action, note, created_at FROM card_events WHERE actor_user_id = ?1",
          login
        )
      : [],
    contexts: login
      ? await all("SELECT org_id, data FROM contexts WHERE user_id = ?1", login)
      : [],
    connectorConfig: await all(
      "SELECT connector, config, updated_at FROM connector_config WHERE user_github_id = ?1", id
    ),
    entitlements: await all(
      "SELECT is_pro, checked_at FROM entitlements WHERE user_github_id = ?1", id
    ),
    aiUsage: await all(
      "SELECT day, used FROM ai_usage WHERE user_github_id = ?1", id
    ),
    ingestedItems: await all(
      "SELECT connector, external_id, org_id, card_id, created_at FROM ingested_items WHERE user_github_id = ?1", id
    ),
    devices: await tryAll(
      "SELECT environment, updated_at FROM device_tokens WHERE user_github_id = ?1", id
    ),
    pushSubscriptions: await tryAll(
      "SELECT user_agent, updated_at FROM push_subscriptions WHERE user_github_id = ?1", id
    ),
    routines: await tryAll(
      `SELECT org_id, kind, title, instruction, cadence, weekday, monthday, hour, minute, timezone, enabled,
              last_run_at, runs, created_at FROM routines WHERE owner_github_id = ?1`, id
    ),
    agentTokens: await tryAll(
      "SELECT org_id, name, prefix, created_at, last_used_at FROM api_tokens WHERE github_id = ?1", id
    ),
    channelMessages: login
      ? await tryAll("SELECT org_id, channel, body, created_at FROM channel_messages WHERE author_login = ?1", login)
      : [],
    playbookRules: login
      ? await tryAll("SELECT org_id, text, origin, created_at FROM memories WHERE created_by = ?1", login)
      : [],
  };
  return out;
}

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
    // A rule in the playbook is the team's, like a business: it stays, and
    // the name comes off. Routines that report to this person stop.
    for (const [sql, binds] of [
      ["UPDATE memories SET created_by = NULL WHERE created_by = ?1", [login]],
      ["DELETE FROM routines WHERE recipient_login = ?1", [login]],
      ["DELETE FROM proposals WHERE login = ?1", [login]],
      // Their direct conversations go with them; what they said in a
      // business's channel stays with the team, unsigned.
      ["DELETE FROM channel_messages WHERE channel LIKE 'dm:%' AND (channel LIKE 'dm:' || ?1 || '|%' OR channel LIKE 'dm:%|' || ?1)", [login]],
      ["UPDATE channel_messages SET author_login = NULL WHERE author_login = ?1", [login]],
      ["DELETE FROM message_reactions WHERE login = ?1", [login]],
      ["DELETE FROM channel_reads WHERE login = ?1", [login]],
      ["UPDATE channel_messages SET pinned_by = NULL WHERE pinned_by = ?1", [login]],
    ]) {
      try {
        await db.prepare(sql).bind(...binds).run();
      } catch (err) {
        if (!/no such table/i.test(String(err?.message))) throw err;
      }
    }
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
    "DELETE FROM connector_sync_state WHERE user_github_id = ?1",
    "DELETE FROM entitlements WHERE user_github_id = ?1",
    "DELETE FROM ai_usage WHERE user_github_id = ?1",
    "DELETE FROM ingested_items WHERE user_github_id = ?1",
    "DELETE FROM device_tokens WHERE user_github_id = ?1",
    "DELETE FROM push_subscriptions WHERE user_github_id = ?1",
    // What this person set the AI to do, and the keys their agents held.
    "DELETE FROM routines WHERE owner_github_id = ?1",
    "DELETE FROM api_tokens WHERE github_id = ?1",
    "DELETE FROM users WHERE github_id = ?1",
    // Keep the deletion tombstone until redemption can no longer find the user.
    "DELETE FROM complimentary_access WHERE user_github_id = ?1",
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
