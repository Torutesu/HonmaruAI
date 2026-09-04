import { CONNECTORS } from "./connectors/index.js";
import { syncAll } from "./sync.js";
import { notifyCard } from "./push.js";
import { sweepRateLimits } from "./ratelimit.js";
import { cardsCreatedSince, markConnectorsSynced } from "./db.js";
import { announceCards } from "./announce.js";
import { providerConfig } from "./provider.js";

// "Your AI triaged three decisions overnight" cannot be true if the AI only
// runs while you are looking at it. Until this existed, a connector sync
// happened when the app was opened — which is the one moment you do not need
// it, because you are already there.
//
// Everything the loop does is already metered per user by checkAIAllowance, so
// a cron sync costs the same allowance as a manual one and cannot become a
// backdoor around the free tier.

const MAX_USERS_PER_RUN = 50;
// One user's sync is a handful of network calls with long waits in them, so a
// few at a time is the difference between fifty users and five hundred. Small
// enough that a burst of model calls does not arrive all at once.
const CONCURRENCY = 5;

/// Users worth syncing: a live session (so we have a GitHub token), a
/// membership (so we know where their cards go), and a connector they have
/// actually linked.
///
/// That last clause used to read `connector_config`, and the only thing that
/// writes one is Notion's database picker — so anyone who connected Gmail or
/// Slack and nothing else was never picked up, by the loop whose entire reason
/// for existing is that connectors should run while you are not looking. The
/// existing test seeded a Notion config, so it passed on the one case that
/// worked.
///
/// Ordered by who has waited longest rather than by newest session: the old
/// order served the same fifty people every run and left the fifty-first
/// waiting for someone to sign out.
async function candidates(db) {
  const now = new Date().toISOString();
  const { results } = await db
    .prepare(
      `SELECT s.token, s.github_id, s.github_access_token, u.login, u.locale,
              (SELECT org_id FROM memberships m WHERE m.user_github_id = s.github_id LIMIT 1) AS org_id,
              (SELECT MIN(COALESCE(l.last_synced_at, ''))
                 FROM connector_links l WHERE l.user_github_id = s.github_id) AS waited_since
       FROM sessions s
       JOIN users u ON u.github_id = s.github_id
       WHERE (s.expires_at IS NULL OR s.expires_at > ?1)
         AND s.created_at = (
           SELECT MAX(s2.created_at) FROM sessions s2
            WHERE s2.github_id = s.github_id
              AND (s2.expires_at IS NULL OR s2.expires_at > ?1)
         )
         AND (
           EXISTS (SELECT 1 FROM connector_links l WHERE l.user_github_id = s.github_id)
           OR EXISTS (SELECT 1 FROM connector_config c WHERE c.user_github_id = s.github_id)
         )
       GROUP BY s.github_id
       ORDER BY waited_since ASC, s.created_at DESC
       LIMIT ?2`
    )
    .bind(now, MAX_USERS_PER_RUN)
    .all();
  return (results || []).filter((row) => row.org_id && row.login);
}

export async function runScheduledSync(env) {
  const provider = providerConfig(env);
  const rows = await candidates(env.DB);
  let synced = 0;
  let created = 0;

  // A few at a time. One user's broken connector must not stop the rest of the
  // run, which is why each is caught on its own.
  for (let offset = 0; offset < rows.length; offset += CONCURRENCY) {
    const batch = rows.slice(offset, offset + CONCURRENCY);
    const counts = await Promise.all(batch.map((row) => syncOneUser(env, provider, row)));
    for (const count of counts) {
      if (count === null) continue;
      synced += 1;
      created += count;
    }
  }

  await sweepRateLimits(env);
  return { users: rows.length, synced, created };
}

/// One person's connectors. Returns the number of cards created, or null when
/// the run failed for them — which must not stop it for anyone else.
async function syncOneUser(env, provider, row) {
  const startedAt = new Date().toISOString();
  const session = {
    token: row.token,
    github_id: row.github_id,
    github_access_token: row.github_access_token,
  };
  try {
    // One connector's outage does not silence the others inside syncAll, and
    // one person's failure does not end the run for everyone else.
    const results = await syncAll(CONNECTORS, {
      env, session,
      orgId: row.org_id,
      userId: row.login,
      readerLanguage: row.locale || "en",
      provider,
    });
    // Their turn is taken whether or not it produced anything, so the next run
    // moves on to whoever has waited longest.
    await markConnectorsSynced(env.DB, row.github_id);
    const newCards = results.reduce((sum, r) => sum + (r.created || 0), 0);
    if (!newCards) return 0;

    const fresh = await cardsCreatedSince(env.DB, row.org_id, row.login, startedAt);
    // Anyone with the app open sees these now. Without it the push below
    // announced a decision that was not yet in the feed it points at.
    await announceCards(env, row.org_id, fresh);
    // One notification for the batch, not one per card: waking someone four
    // times because their inbox was busy is how notifications get turned off.
    if (fresh.length) {
      await notifyCard(env, {
        card: fresh.length === 1
          ? fresh[0]
          : { ...fresh[0], id: `digest-${row.login}-${startedAt}`, title: `${fresh.length} decisions need you`, senderUserID: null },
        kind: "created",
        excludeLogin: null,
        badge: fresh.length,
      });
    }
    return newCards;
  } catch (err) {
    console.error("scheduled sync failed", row.login, err?.message || err);
    return null;
  }
}
