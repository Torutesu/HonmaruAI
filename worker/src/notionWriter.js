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
  ].filter(Boolean);
  return lines.map((content) => ({ block_property: "paragraph", content }));
}

// Returns true when a row was written. Never throws: recording a decision
// elsewhere must not be able to break the decision itself.
export async function writeDecisionToNotion({ env, orgId, login, card }) {
  try {
    if (!env.COMPOSIO_API_KEY || !login) return false;
    const user = await getUserByLogin(env.DB, login);
    if (!user) return false;
    const config = await getConnectorConfig(env.DB, user.github_id, "notion");
    if (!config?.databaseId) return false;

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
    );

    // The insert returns the new page id at data.id — the SAME id a later query
    // returns. Recording it in ingested_items (the table inbound dedups against)
    // stops the decision we just wrote from echoing back in as a fresh card, and
    // a wasted AI call, on the next sync.
    const pageId = payload?.data?.id;
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
