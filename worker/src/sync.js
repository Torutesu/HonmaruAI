import { executeTool } from "./composio.js";
import { toolSlugFor } from "./connectors/index.js";
import { triageMessage } from "./triage.js";
import { isIngested, markIngested, saveCard, getConnectorConfig } from "./db.js";
import { allowanceFor } from "./gate.js";
import { fileCardUnderBusiness } from "./classify.js";
import { jevFor } from "./orgAI.js";

// The loop is deliberately ignorant of which connector it is running: fetch,
// skip what we have seen, ask whether it needs a decision, and record the answer
// either way.
export async function syncConnector(connector, { env, session, orgId, userId, readerLanguage, provider }) {
  // Connectors that need a per-user setting (Notion needs a chosen database)
  // sit out until it exists — no error, no half-state, and no Composio call.
  const config = await getConnectorConfig(env.DB, session.github_id, connector.id);
  if (connector.requiresConfig && !config) {
    return { connector: connector.id, scanned: 0, created: 0, skipped: "not configured" };
  }

  // Always the caller's own Composio identity. A shared id here would mean
  // every user reading one person's messages.
  let payload;
  try {
    payload = await executeTool(env.COMPOSIO_API_KEY, toolSlugFor(env, connector), String(session.github_id), connector.buildArgs(config));
  } catch (err) {
    const text = String(err?.message || err);
    // Never connected: nothing to read, and nothing to report as broken.
    if (/ConnectedAccountNotFound|No connected account/i.test(text)) {
      return { connector: connector.id, scanned: 0, created: 0, skipped: "not connected" };
    }
    // Composio renamed the tool. The connector names what it moved to.
    if (/ToolNotFound|not found/i.test(text) && Array.isArray(connector.fallbackToolSlugs)) {
      let last = err;
      for (const slug of connector.fallbackToolSlugs) {
        try {
          payload = await executeTool(env.COMPOSIO_API_KEY, slug, String(session.github_id), connector.buildArgs(config, slug));
          last = null;
          break;
        } catch (e2) { last = e2; }
      }
      if (last) throw last;
    } else {
      throw err;
    }
  }

  const messages = connector.parse(payload);
  let created = 0;

  for (const message of messages) {
    if (!message.id) continue;
    if (await isIngested(env.DB, connector.id, message.id, session.github_id)) continue;
    // A manual pull and the cron can read the same new message at once;
    // only the run that claims it judges it, so it is one card and one
    // model call. Claimed, it may have been finished just before: asked
    // again. The claim goes when the work does, or is taken over once
    // stale, so a run that died holding it does not hold the message for
    // ever.
    const claimed = await claimItem(env.DB, connector.id, message.id, session.github_id, orgId);
    if (!claimed) continue;
    try {
      if (await isIngested(env.DB, connector.id, message.id, session.github_id)) continue;
      created += await ingestOne(connector, message, { env, session, orgId, userId, readerLanguage, provider });
    } finally {
      await releaseItem(env.DB, connector.id, message.id, session.github_id, orgId);
    }
  }

  return { connector: connector.id, scanned: messages.length, created };
}

/// How long a claim on a message keeps another run off it: far longer than
/// judging one message takes, short enough that a run cut off mid-way is
/// picked up by the next sync.
const CLAIM_MS = 10 * 60 * 1000;
const claimKey = (connectorId) => `claim:${connectorId}`;

async function claimItem(db, connectorId, externalId, githubId, orgId) {
  const now = new Date();
  const res = await db.prepare(
    `INSERT INTO ingested_items (connector, external_id, user_github_id, org_id, card_id, created_at)
     VALUES (?1, ?2, ?3, ?4, NULL, ?5)
     ON CONFLICT(connector, external_id, user_github_id) DO UPDATE SET created_at = excluded.created_at
       WHERE ingested_items.created_at < ?6`
  ).bind(claimKey(connectorId), externalId, String(githubId), orgId, now.toISOString(), new Date(now.getTime() - CLAIM_MS).toISOString()).run();
  return Boolean(res.meta?.changes);
}

async function releaseItem(db, connectorId, externalId, githubId, orgId) {
  await db.prepare("DELETE FROM ingested_items WHERE connector = ?1 AND external_id = ?2 AND user_github_id = ?3 AND org_id IS ?4")
    .bind(claimKey(connectorId), externalId, String(githubId), orgId ?? null).run()
    .catch((err) => console.error("sync claim release failed", err?.message || err));
}

/// One new message judged, and its card made when it needs a decision.
/// The number of cards made: one or none.
async function ingestOne(connector, message, { env, session, orgId, userId, readerLanguage, provider }) {
  let cardId = null;
  // Checked per message, so a sync stops creating cards the moment the day's
  // allowance runs out rather than blowing through it.
  const allowance = await allowanceFor(env, orgId, { githubId: String(session.github_id) });
  // System One asks "does this need a decision?" for a fraction of a cent
  // whether or not the person has language-model allowance left; the
  // model is only offered for the words, and only within the allowance.
  const systemOne = await jevFor(env, orgId);
  const result = (provider && allowance.allowed) || systemOne
    ? await triageMessage(message, { provider: allowance.allowed ? provider : null, systemOne, readerLanguage, sourceLabel: connector.label })
    : { called: false, card: null };
  // Metered on the call, not on the card. Most mail correctly needs no
  // decision, and charging only for the ones that produce a card would let an
  // inbox of noise run the model for free.
  if (result.called && allowance.metered) await allowance.consume();
  const triaged = result.card;

  if (triaged) {
    cardId = crypto.randomUUID();
    // Filed in the background like every other card. Its own allowance
    // check: the one above was spent on the triage.
    const business = await fileCardUnderBusiness(env, {
      orgId, provider, githubId: session.github_id,
      card: { ...triaged, sourceDetail: `${message.from} · ${message.subject}` },
      allowance: await allowanceFor(env, orgId, { githubId: String(session.github_id) }),
    });
    await saveCard(env.DB, orgId, {
      id: cardId,
      ...(business ? { business } : {}),
      recipientUserID: userId,
      senderUserID: userId,
      type: triaged.cardType,
      format: "approve",
      title: triaged.title,
      summary: triaged.summary,
      context: triaged.context,
      priority: triaged.priority,
      status: "pending",
      createdAt: new Date().toISOString(),
      sourceApp: connector.label,
      sourceDetail: `${message.from} · ${message.subject}`,
      source: sourceOf(connector, message),
    });
  }

  // Recorded even when rejected, so the model never re-judges the same item.
  await markIngested(env.DB, {
    connector: connector.id, externalId: message.id,
    githubId: session.github_id, orgId, cardId,
  });
  return cardId ? 1 : 0;
}

/// What a card remembers about the message it came from — enough to send a
/// reply back the same way, and nothing the card does not already show.
export function sourceOf(connector, message) {
  const keep = (v) => (typeof v === "string" && v ? v.slice(0, 300) : undefined);
  const source = {
    connector: connector.id, id: keep(message.id), threadId: keep(message.threadId),
    from: keep(message.from), channel: keep(message.channel), ts: keep(message.ts),
  };
  return Object.fromEntries(Object.entries(source).filter(([, v]) => v !== undefined));
}

// One connector's outage must not silence the others.
export async function syncAll(connectors, context) {
  const results = [];
  for (const connector of connectors) {
    try {
      results.push(await syncConnector(connector, context));
    } catch (err) {
      results.push({ connector: connector.id, scanned: 0, created: 0, error: String(err.message).slice(0, 200) });
    }
  }
  return results;
}
