import type { OrgEvent } from "@honmaru/protocol";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import { newId, now } from "./ids.js";
import type { Logger } from "./log.js";

// ---------------------------------------------------------------------------
// Agent memory — the context layer. Every decision leaves a trace:
// deterministic capture turns decision events into per-user observations
// ("Bob declined 'Friday deploy': too risky before the weekend"), and an
// async LLM job periodically condenses observations into a handful of
// stable preferences. Both feed straight back into routing prompts, so
// each user's AI gets better at speaking to that person over time.
// ---------------------------------------------------------------------------

export interface MemoryEntry {
  id: string;
  orgId: string;
  userId: string;
  kind: "observation" | "preference";
  content: string;
  sourceCardId: string | null;
  createdAt: string;
}

const MAX_OBSERVATIONS_PER_USER = 50;
export const CONDENSE_THRESHOLD = 12;

function insert(
  db: Db,
  orgId: string,
  userId: string,
  kind: MemoryEntry["kind"],
  content: string,
  sourceCardId: string | null
): void {
  db.prepare(
    `INSERT INTO agent_memories (id, org_id, user_id, kind, content, source_card_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(newId("mem"), orgId, userId, kind, content, sourceCardId, now());
  // Bound growth: keep only the newest observations per user.
  db.prepare(
    `DELETE FROM agent_memories WHERE org_id = ? AND user_id = ? AND kind = 'observation'
       AND id NOT IN (
         SELECT id FROM agent_memories
         WHERE org_id = ? AND user_id = ? AND kind = 'observation'
         ORDER BY created_at DESC LIMIT ?
       )`
  ).run(orgId, userId, orgId, userId, MAX_OBSERVATIONS_PER_USER);
}

export function listMemories(
  db: Db,
  orgId: string,
  userId?: string
): MemoryEntry[] {
  const rows = (
    userId
      ? db
          .prepare(
            `SELECT * FROM agent_memories WHERE org_id = ? AND user_id = ?
             ORDER BY created_at DESC`
          )
          .all(orgId, userId)
      : db
          .prepare(
            `SELECT * FROM agent_memories WHERE org_id = ? ORDER BY created_at DESC`
          )
          .all(orgId)
  ) as {
    id: string;
    org_id: string;
    user_id: string;
    kind: MemoryEntry["kind"];
    content: string;
    source_card_id: string | null;
    created_at: string;
  }[];
  return rows.map((row) => ({
    id: row.id,
    orgId: row.org_id,
    userId: row.user_id,
    kind: row.kind,
    content: row.content,
    sourceCardId: row.source_card_id,
    createdAt: row.created_at,
  }));
}

// Deterministic capture from committed events. Returns userIds whose
// observation count crossed the condensation threshold.
export function captureFromEvents(db: Db, events: OrgEvent[]): string[] {
  const crossed = new Set<string>();
  for (const event of events) {
    if (event.type !== "card_updated") continue;
    const card = event.payload.card;
    // Only the recipient's own decisions teach us about the recipient.
    if (event.actorUserId !== card.recipientUserId) continue;

    let content: string | null = null;
    if (card.status === "rejected") {
      content = `Declined "${card.title}" (${card.type}, ${card.priority})${
        card.revisionNote ? `: ${card.revisionNote}` : ""
      }`;
    } else if (card.status === "revised" && card.revisionNote) {
      content = `Asked for changes on "${card.title}": ${card.revisionNote}`;
    } else if (card.status === "approved") {
      content = `Approved "${card.title}" (${card.type}, ${card.priority})`;
    } else if (card.status === "delegated") {
      content = `Passed "${card.title}" to someone else (${card.type})`;
    }
    if (!content) continue;

    insert(db, event.orgId, card.recipientUserId, "observation", content, card.id);
    const count = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM agent_memories
           WHERE org_id = ? AND user_id = ? AND kind = 'observation'`
        )
        .get(event.orgId, card.recipientUserId) as { n: number }
    ).n;
    if (count >= CONDENSE_THRESHOLD) {
      crossed.add(`${event.orgId} ${card.recipientUserId}`);
    }
  }
  return [...crossed];
}

// Prompt block for routing/refinement: preferences first (stable,
// condensed), then the freshest observations, hard-capped per user.
export function memoryContext(
  db: Db,
  orgId: string,
  userIds: string[],
  nameOf: (userId: string) => string,
  perUser = 4
): string {
  const lines: string[] = [];
  for (const userId of userIds) {
    const entries = listMemories(db, orgId, userId);
    const preferences = entries.filter((entry) => entry.kind === "preference");
    const observations = entries.filter((entry) => entry.kind === "observation");
    const picked = [...preferences.slice(0, perUser)];
    for (const observation of observations) {
      if (picked.length >= perUser) break;
      picked.push(observation);
    }
    for (const entry of picked) {
      lines.push(`- ${nameOf(userId)}: ${entry.content}`);
    }
  }
  return lines.length > 0 ? `What each person's AI has learned:\n${lines.join("\n")}` : "";
}

// --- LLM condensation (async job) ------------------------------------------

export interface CondensePayload {
  orgId: string;
  userId: string;
}

export function makeCondenseHandler(deps: {
  db: Db;
  config: Config;
  log: Logger;
}) {
  return async (raw: unknown): Promise<void> => {
    const payload = raw as CondensePayload;
    const { db, config, log } = deps;
    if (!config.openRouter) return;
    const observations = listMemories(db, payload.orgId, payload.userId).filter(
      (entry) => entry.kind === "observation"
    );
    if (observations.length < CONDENSE_THRESHOLD) return;

    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.openRouter.apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": config.openRouter.appUrl,
        "X-Title": config.openRouter.appName,
      },
      body: JSON.stringify({
        model: config.openRouter.model,
        temperature: 0.2,
        max_tokens: 300,
        messages: [
          {
            role: "system",
            content:
              "You maintain a colleague profile for an AI work router. From raw decision observations, write at most 5 stable preferences that predict how this person decides (what they approve, what they push back on, what context they need). One line each, no numbering, third person, concrete.",
          },
          {
            role: "user",
            content: observations.map((entry) => `- ${entry.content}`).join("\n"),
          },
        ],
      }),
    });
    const data = (await response.json()) as {
      error?: { message?: string };
      choices?: { message?: { content?: string } }[];
    };
    if (!response.ok) {
      throw new Error(data.error?.message ?? "condense request failed");
    }
    const text = data.choices?.[0]?.message?.content ?? "";
    const preferences = text
      .split("\n")
      .map((line) => line.replace(/^[-*•\d.\s]+/, "").trim())
      .filter((line) => line.length > 4)
      .slice(0, 5);
    if (preferences.length === 0) return;

    db.transaction(() => {
      db.prepare(
        `DELETE FROM agent_memories WHERE org_id = ? AND user_id = ? AND kind = 'preference'`
      ).run(payload.orgId, payload.userId);
      // Observations condensed into preferences are consumed.
      db.prepare(
        `DELETE FROM agent_memories WHERE org_id = ? AND user_id = ? AND kind = 'observation'`
      ).run(payload.orgId, payload.userId);
      for (const content of preferences) {
        insert(db, payload.orgId, payload.userId, "preference", content, null);
      }
    })();
    log.info(
      { orgId: payload.orgId, userId: payload.userId, count: preferences.length },
      "agent memory condensed"
    );
  };
}
