import { CONNECTORS } from "./connectors/index.js";
import { syncAll } from "./sync.js";
import { notifyCard } from "./push.js";
import { sweepRateLimits } from "./ratelimit.js";

// "Your AI triaged three decisions overnight" cannot be true if the AI only
// runs while you are looking at it. Until this existed, a connector sync
// happened when the app was opened — which is the one moment you do not need
// it, because you are already there.
//
// Everything the loop does is already metered per user by checkAIAllowance, so
// a cron sync costs the same allowance as a manual one and cannot become a
// backdoor around the free tier.

const MAX_USERS_PER_RUN = 50;

/// Users worth syncing: a live session (so we have a GitHub token), a
/// membership (so we know where their cards go), and at least one configured
/// connector. Anyone else has nothing to fetch.
async function candidates(db) {
  const { results } = await db
    .prepare(
      `SELECT s.token, s.github_id, s.github_access_token, u.login, u.locale,
              (SELECT org_id FROM memberships m WHERE m.user_github_id = s.github_id LIMIT 1) AS org_id
       FROM sessions s
       JOIN users u ON u.github_id = s.github_id
       WHERE (s.expires_at IS NULL OR s.expires_at > ?1)
         AND EXISTS (SELECT 1 FROM connector_config c WHERE c.user_github_id = s.github_id)
       GROUP BY s.github_id
       ORDER BY s.created_at DESC
       LIMIT ?2`
    )
    .bind(new Date().toISOString(), MAX_USERS_PER_RUN)
    .all();
  return (results || []).filter((row) => row.org_id && row.login);
}

function providerConfig(env) {
  if (env.OPENAI_API_KEY) {
    return {
      providerName: "OpenAI",
      endpoint: "https://api.openai.com/v1/chat/completions",
      apiKey: env.OPENAI_API_KEY,
      model: env.OPENAI_MODEL || "gpt-4o-mini",
    };
  }
  if (env.OPENROUTER_API_KEY) {
    return {
      providerName: "OpenRouter",
      endpoint: "https://openrouter.ai/api/v1/chat/completions",
      apiKey: env.OPENROUTER_API_KEY,
      model: env.OPENROUTER_MODEL || "inclusionai/ling-3.0-flash:free",
    };
  }
  return undefined;
}

/// Cards created by this run, so the people they landed on can be told. Read
/// after the sync rather than returned by it: syncAll reports counts, and
/// threading cards back through it would make every caller carry a payload only
/// this one needs.
async function cardsCreatedSince(db, orgId, login, since) {
  const { results } = await db
    .prepare(
      `SELECT data FROM cards
       WHERE org_id = ?1 AND recipient_user_id = ?2 AND created_at >= ?3 AND status = 'pending'`
    )
    .bind(orgId, login, since)
    .all();
  return (results || []).map((row) => {
    try {
      return JSON.parse(row.data);
    } catch {
      return null;
    }
  }).filter(Boolean);
}

export async function runScheduledSync(env) {
  const provider = providerConfig(env);
  const rows = await candidates(env.DB);
  let synced = 0;
  let created = 0;

  for (const row of rows) {
    const startedAt = new Date().toISOString();
    const session = {
      token: row.token,
      github_id: row.github_id,
      github_access_token: row.github_access_token,
    };
    try {
      // One user's broken connector must not stop the rest of the run, exactly
      // as one connector's outage does not silence the others inside syncAll.
      const results = await syncAll(CONNECTORS, {
        env, session,
        orgId: row.org_id,
        userId: row.login,
        readerLanguage: row.locale || "en",
        provider,
      });
      synced += 1;
      const newCards = results.reduce((sum, r) => sum + (r.created || 0), 0);
      if (!newCards) continue;
      created += newCards;

      const fresh = await cardsCreatedSince(env.DB, row.org_id, row.login, startedAt);
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
    } catch (err) {
      console.error("scheduled sync failed", row.login, err?.message || err);
    }
  }

  await sweepRateLimits(env);
  return { users: rows.length, synced, created };
}
