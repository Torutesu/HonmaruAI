// A conversation's canvas: one shared document, as Slack's channel canvas
// and Ando's Channel Context — the procedure, what was decided, who owns
// what. Anyone who can read the conversation reads and edits it.
//
// Saves are versioned. A save names the version it was made from; if
// somebody else saved since, it is refused with theirs, so two people
// editing at once are told rather than one silently erasing the other.
// The last 30 versions are kept and any can be put back.
//
// With a model, your AI can draft an update from what was said lately —
// shown to you first, never saved on its own.

import { noteUsage } from "./ledger.js";
import { safe } from "./log.js";

export const MAX_CANVAS_CHARS = 50_000;
const KEEP_REVISIONS = 30;

/// Who wrote it, by name — never the login.
const nameOf = (members, login) => members.find((m) => m.login === login)?.name || null;

export async function getCanvas(db, orgId, key) {
  return db.prepare("SELECT body, version, updated_by, updated_at FROM channel_canvases WHERE org_id = ?1 AND channel = ?2")
    .bind(orgId, key).first().catch(() => null);
}

export function toClientCanvas(row, members) {
  if (!row) return { body: "", version: 0, updatedBy: null, updatedAt: null };
  return { body: row.body, version: row.version, updatedBy: nameOf(members, row.updated_by), updatedAt: row.updated_at };
}

export async function listRevisions(db, orgId, key, members) {
  const { results } = await db.prepare(
    "SELECT version, updated_by, updated_at, length(body) AS size FROM channel_canvas_revisions WHERE org_id = ?1 AND channel = ?2 ORDER BY version DESC LIMIT ?3"
  ).bind(orgId, key, KEEP_REVISIONS).all().catch(() => ({ results: [] }));
  return (results || []).map((r) => ({ version: r.version, updatedBy: nameOf(members, r.updated_by), updatedAt: r.updated_at, size: r.size }));
}

export async function getRevision(db, orgId, key, version) {
  return db.prepare("SELECT body, version, updated_by, updated_at FROM channel_canvas_revisions WHERE org_id = ?1 AND channel = ?2 AND version = ?3")
    .bind(orgId, key, version).first().catch(() => null);
}

/// Save a new version, made from `baseVersion`. Refused with the current
/// one when somebody else saved in between.
export async function saveCanvas(db, { orgId, key, body, baseVersion, login }) {
  const text = String(body ?? "").replace(/\r\n?/g, "\n");
  if (text.length > MAX_CANVAS_CHARS) return { error: `A canvas holds up to ${MAX_CANVAS_CHARS.toLocaleString("en")} characters.`, status: 400 };
  const current = await getCanvas(db, orgId, key);
  const have = current?.version || 0;
  if (Number(baseVersion ?? -1) !== have) return { conflict: true, current };
  if (current && current.body === text) return { canvas: current, unchanged: true };
  const version = have + 1;
  const at = new Date().toISOString();
  await db.batch([
    db.prepare(
      `INSERT INTO channel_canvases (org_id, channel, body, version, updated_by, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT (org_id, channel) DO UPDATE SET body = excluded.body, version = excluded.version, updated_by = excluded.updated_by, updated_at = excluded.updated_at
       WHERE channel_canvases.version = ?7`
    ).bind(orgId, key, text, version, login, at, have),
    db.prepare("INSERT OR IGNORE INTO channel_canvas_revisions (org_id, channel, version, body, updated_by, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")
      .bind(orgId, key, version, text, login, at),
    db.prepare(
      `DELETE FROM channel_canvas_revisions WHERE org_id = ?1 AND channel = ?2 AND version <= ?3`
    ).bind(orgId, key, version - KEEP_REVISIONS),
  ]);
  const saved = await getCanvas(db, orgId, key);
  // Two saves raced past the check: the one whose write did not land is
  // told, like any other conflict.
  if (saved?.version !== version || saved.updated_by !== login || saved.body !== text) return { conflict: true, current: saved };
  return { canvas: saved };
}

const DRAFT_PROMPT = `You keep a team's shared canvas for one conversation: a living document of how things are done, what was decided, who owns what, and what is still open.
You are given the canvas as it stands and the recent messages. Return the canvas updated with what the messages settled or changed.
Rules:
- Keep everything already in the canvas that the messages do not change. Never drop a section, a name, a number or a link.
- Add decisions, owners, dates, procedures and open questions the messages make clear. Do not invent anything.
- Write in the language the canvas is written in; if it is empty, in the reader's language.
- Markdown only: "## " headings, "- " bullets, "- [ ] " for open to-dos and "- [x] " for done ones, **bold** sparingly. No HTML, no code fences around the whole thing.
- Reply as JSON: {"body": "<the whole updated canvas>", "note": "<one short sentence on what changed, in the reader's language>"}.`;

/// A proposed update from the conversation, for its reader to look at and
/// save or not. Unchanged, with a note saying why, without a model.
export async function draftCanvas({ body, messages, locale, provider, allowance, unavailableNote }) {
  const unchanged = { body, note: unavailableNote, byModel: false };
  if (!provider || (allowance && !allowance.allowed) || !messages.length) return unchanged;
  try {
    const said = messages.map((m) => `[${m.at.slice(0, 16).replace("T", " ")}] ${m.who}: ${m.text}`).join("\n").slice(-20_000);
    const res = await fetch(provider.endpoint, {
      signal: AbortSignal.timeout(60_000),
      method: "POST",
      headers: { Authorization: `Bearer ${provider.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: provider.model, temperature: 0.2, max_tokens: 4000,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: DRAFT_PROMPT },
          { role: "user", content: `Reader language: ${locale}\n<canvas>\n${String(body || "").slice(0, MAX_CANVAS_CHARS)}\n</canvas>\n<messages>\n${said}\n</messages>` },
        ],
      }),
    });
    if (!res.ok) return unchanged;
    const data = await res.json();
    noteUsage(provider, "canvas_draft", data);
    if (allowance?.metered) await allowance.consume();
    let parsed = null;
    try { parsed = JSON.parse(data?.choices?.[0]?.message?.content || ""); } catch { parsed = null; }
    const next = typeof parsed?.body === "string" ? parsed.body.trim() : "";
    if (!next) return unchanged;
    return { body: next.slice(0, MAX_CANVAS_CHARS), note: typeof parsed?.note === "string" ? parsed.note.slice(0, 200) : "", byModel: true };
  } catch (err) {
    console.error("canvas draft failed", safe(err?.message));
    return unchanged;
  }
}
