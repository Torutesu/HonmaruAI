import { executeTool } from "./composio.js";
import { triageMessage } from "./triage.js";
import { isIngested, markIngested, saveCard } from "./db.js";
import { checkAIAllowance } from "./gate.js";

// The loop is deliberately ignorant of which connector it is running: fetch,
// skip what we have seen, ask whether it needs a decision, and record the answer
// either way.
export async function syncConnector(connector, { env, session, orgId, userId, readerLanguage, provider }) {
  const payload = await executeTool(
    env.COMPOSIO_API_KEY,
    connector.toolSlug,
    // Always the caller's own Composio identity. A shared id here would mean
    // every user reading one person's messages.
    String(session.github_id),
    connector.buildArgs()
  );

  const messages = connector.parse(payload);
  let created = 0;

  for (const message of messages) {
    if (!message.id) continue;
    if (await isIngested(env.DB, connector.id, message.id, session.github_id)) continue;

    let cardId = null;
    // Checked per message, so a sync stops creating cards the moment the day's
    // allowance runs out rather than blowing through it.
    const allowance = await checkAIAllowance(env, { githubId: String(session.github_id) });
    const triaged = provider && allowance.allowed
      ? await triageMessage(message, { provider, readerLanguage, sourceLabel: connector.label })
      : null;
    if (triaged && allowance.metered) await allowance.consume();

    if (triaged) {
      cardId = crypto.randomUUID();
      await saveCard(env.DB, orgId, {
        id: cardId,
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
      });
      created += 1;
    }

    // Recorded even when rejected, so the model never re-judges the same item.
    await markIngested(env.DB, {
      connector: connector.id, externalId: message.id,
      githubId: session.github_id, orgId, cardId,
    });
  }

  return { connector: connector.id, scanned: messages.length, created };
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
