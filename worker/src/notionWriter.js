import { executeTool } from "./composio.js";
import { getConnectorConfig, getUserByLogin, markIngested } from "./db.js";

// A decision becomes one row. Notion databases have arbitrary schemas, so the
// only property this touches is the title — every database has exactly one, and
// guessing at the rest is how integrations break silently. Everything else goes
// in the page body (child_blocks), which renders in any database.
function childBlocksFor(card) {
  const d = card.decision || {};
  const lines = [
    card.summary,
    d.action ? `**Decision:** ${d.action}` : null,
    d.actorUserID ? `**By:** ${d.actorUserID}` : null,
    d.decidedAt ? `**When:** ${d.decidedAt}` : null,
    card.sourceApp ? `**Source:** ${card.sourceApp}` : null,
    card.business ? `**Business:** ${card.business}` : null,
  ].filter(Boolean);
  return lines.map((content) => ({ block_property: "paragraph", content }));
}

/// Where the new page's id is, either way Composio wrapped the answer.
///
/// Every inbound parser in connectors/ handles both shapes, with the same
/// comment: the payload arrives under `data` on one execution path and under
/// `results[0].response.data` on the other. This one read `data.id` alone, and
/// the id is what suppresses the echo — so on the wrapped path the decision we
/// had just written came back on the next sync as a brand new card about
/// itself, complete with a model call to triage it. Nothing reports that; it
/// looks like the AI inventing work.
function pageIdFrom(payload) {
  return payload?.data?.id
    || payload?.results?.[0]?.response?.data?.id
    || payload?.id
    || null;
}

/// Where a decision already written to Notion is remembered (ingested_items,
/// with no card: nothing reads it as the source of one).
const EXPORTED = "notion-decision";

// Returns true when a row was written. Never throws: recording a decision
// elsewhere must not be able to break the decision itself.
export async function writeDecisionToNotion({ env, orgId, login, card }) {
  try {
    if (!env.COMPOSIO_API_KEY || !login) return false;
    const user = await getUserByLogin(env.DB, login);
    if (!user) return false;
    const config = await getConnectorConfig(env.DB, user.github_id, "notion");
    if (!config?.databaseId) return false;

    // One page per decision, however many times the card carrying it is
    // delivered: claimed before the write, so a replay or a second delivery
    // at the same moment finds it taken. Given back when the write fails, so
    // the decision can still be written by a later try.
    const d = card.decision || {};
    const mark = `${card.id}|${d.action || ""}|${d.decidedAt || ""}`;
    const claim = await env.DB.prepare(
      `INSERT INTO ingested_items (connector, external_id, user_github_id, org_id, card_id, created_at)
       VALUES (?1, ?2, ?3, ?4, NULL, ?5) ON CONFLICT(connector, external_id, user_github_id) DO NOTHING`
    ).bind(EXPORTED, mark, String(user.github_id), orgId || "", new Date().toISOString()).run();
    if (!claim.meta?.changes) return false;
    const release = () => env.DB.prepare("DELETE FROM ingested_items WHERE connector = ?1 AND external_id = ?2 AND user_github_id = ?3 AND org_id = ?4")
      .bind(EXPORTED, mark, String(user.github_id), orgId || "").run().catch(() => {});

    const payload = await executeTool(
      env.COMPOSIO_API_KEY, "NOTION_INSERT_ROW_DATABASE", String(user.github_id),
      {
        database_id: config.databaseId,
        // properties is a LIST of {name, type, value} (verified live). The name
        // is the literal "title" — the Notion *id* of the title property, the
        // same for every database — so we never have to know or fetch the
        // user-defined display name (e.g. "Name", "件名"). A wrong name is
        // rejected by Notion even with type:"title"; "title" always resolves.
        properties: [{ name: "title", type: "title", value: card.title || "Untitled" }],
        child_blocks: childBlocksFor(card),
      }
    ).catch(async (err) => { await release(); throw err; });

    // The insert returns the new page id at data.id — the SAME id a later query
    // returns. Recording it in ingested_items (the table inbound dedups against)
    // stops the decision we just wrote from echoing back in as a fresh card, and
    // a wasted AI call, on the next sync.
    const pageId = pageIdFrom(payload);
    if (pageId && orgId) {
      await markIngested(env.DB, {
        connector: "notion", externalId: pageId,
        githubId: user.github_id, orgId, cardId: card.id || null,
      });
    }
    return true;
  } catch (err) {
    // The message, not the page contents — never log a row's body.
    console.error("notion write failed", err?.message || err);
    return false;
  }
}
