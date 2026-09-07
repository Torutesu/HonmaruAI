// The record: what was decided, per business, written by nobody.
//
// The minimum documentation a team of ten running ten businesses needs is an
// answer to "what did we decide about the hotel, and when?" — and the answer
// is already in the cards. This renders it: per business, the decisions in
// reverse order, what is still open, and who decided. Markdown when asked,
// so it pastes into Notion or a README; JSON for the client.
//
// Nothing is stored and no model is called: the record is a view, so it is
// never stale and never wrong about what happened.

import { loadStore, listBusinesses } from "./db.js";
import { actionLabel, displayName } from "./notifyCopy.js";

export async function buildRecord(db, orgId, { locale = "en" } = {}) {
  const store = await loadStore(db, orgId);
  const businesses = await listBusinesses(db, orgId);
  const names = new Map(businesses.map((b) => [b.slug, b.name]));
  const sections = new Map();
  const sectionFor = (slug) => {
    const key = slug || "";
    if (!sections.has(key)) {
      sections.set(key, { slug: key, name: key ? names.get(key) || key : null, decided: [], open: [] });
    }
    return sections.get(key);
  };
  for (const b of businesses) sectionFor(b.slug);

  for (const cards of Object.values(store)) {
    for (const card of cards) {
      const section = sectionFor(card.business);
      const local = card.localized?.[locale];
      const entry = {
        id: card.id,
        title: local?.title || card.title || "",
        summary: local?.summary || card.summary || "",
        type: card.type,
        priority: card.priority,
        sender: displayName(card.senderUserID),
        recipient: displayName(card.recipientUserID),
        createdAt: card.createdAt,
        sourceApp: card.sourceApp || null,
      };
      if (card.decision?.action) {
        section.decided.push({
          ...entry,
          action: card.decision.action,
          actionLabel: actionLabel(locale, card.decision.action),
          actor: displayName(card.decision.actorUserID),
          decidedAt: card.decision.decidedAt || null,
          note: card.decision.note || card.decision.replyText || null,
        });
      } else if (card.status === "pending") {
        section.open.push(entry);
      }
    }
  }

  const list = [...sections.values()];
  for (const s of list) {
    s.decided.sort((a, b) => String(b.decidedAt || "").localeCompare(String(a.decidedAt || "")));
    s.open.sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")));
  }
  // Named businesses first, most recently decided first; the unfiled last.
  list.sort((a, b) => {
    if (!a.slug !== !b.slug) return a.slug ? -1 : 1;
    return String(b.decided[0]?.decidedAt || "").localeCompare(String(a.decided[0]?.decidedAt || ""));
  });
  return { orgId, generatedAt: new Date().toISOString(), businesses: list.filter((s) => s.slug || s.decided.length || s.open.length) };
}

const T = {
  en: { title: "Decision record", open: "Open", decided: "Decided", unfiled: "Not yet filed", by: "by", waitingOn: "waiting on", none: "Nothing yet." },
  ja: { title: "決定の記録", open: "未決", decided: "決定済み", unfiled: "未分類", by: "決定者", waitingOn: "待ち", none: "まだありません。" },
};

function day(iso) {
  return iso ? String(iso).slice(0, 10) : "";
}

export function recordToMarkdown(record, locale = "en") {
  const t = T[locale] || T.en;
  const lines = [`# ${t.title} · ${record.orgId}`, "", `_${day(record.generatedAt)}_`, ""];
  if (!record.businesses.length) lines.push(t.none);
  for (const b of record.businesses) {
    lines.push(`## ${b.name || t.unfiled}`, "");
    if (b.open.length) {
      lines.push(`### ${t.open} (${b.open.length})`, "");
      for (const c of b.open) lines.push(`- [ ] ${c.title} — ${t.waitingOn} ${c.recipient}${c.createdAt ? ` · ${day(c.createdAt)}` : ""}`);
      lines.push("");
    }
    lines.push(`### ${t.decided} (${b.decided.length})`, "");
    if (!b.decided.length) lines.push(t.none, "");
    for (const c of b.decided) {
      lines.push(`- **${day(c.decidedAt)}** ${c.title} — ${c.actionLabel} ${t.by} ${c.actor}${c.note ? ` — “${c.note}”` : ""}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}
