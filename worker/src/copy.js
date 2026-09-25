import { primaryLanguage, languageName } from "./language.js";
import { providerFor } from "./orgAI.js";
import { providerConfig } from "./provider.js";
import { noteUsage, settleUsage } from "./ledger.js";

// The words the Worker writes itself — a notification's routing line, an
// email's intro, a bot's reply in a channel, a schedule said out loud — in
// whatever language the reader reads.
//
// Each module keeps its own catalog: English, which is the source, and the
// languages we have written by hand. Any other language is written by the
// model the first time someone who reads it needs it, checked (every
// {placeholder} has to survive), stored in D1 and kept in memory, so it costs
// one call per language per catalog, ever — not one per notification. A
// language nobody can write yet, or a deployment with no model, reads English:
// someone we cannot speak to is still told.
//
// Lookups are synchronous so templates stay simple. The async part is
// `loadCopy`, which every path that writes to a reader awaits first.

const CATALOGS = new Map();
const LEARNED = new Map();
const INFLIGHT = new Map();
const FAILED = new Map();
const RETRY_AFTER_MS = 10 * 60 * 1000;

/// A module's words: `{ en: { key: "template" }, ja: {...}, ... }`, flat.
/// Returns the lookup for that catalog.
export function registerCatalog(name, tables) {
  CATALOGS.set(name, tables);
  return (locale, key, vars, fallback) => text(name, locale, key, vars, fallback);
}

function fill(template, vars = {}) {
  return String(template).replace(/\{(\w+)\}/g, (_, key) => String(vars[key] ?? ""));
}

/// One string in the reader's language: written by hand, else learned, else
/// English, else `fallback` (the key itself unless given).
export function text(name, locale, key, vars, fallback = key) {
  const lang = primaryLanguage(locale) || "en";
  const tables = CATALOGS.get(name) || {};
  const template = tables[lang]?.[key] ?? LEARNED.get(lang)?.get(name)?.[key] ?? tables.en?.[key];
  return template === undefined ? fallback : fill(template, vars || {});
}

/// The languages written by hand in every catalog — the ones that never need
/// a model to be spoken.
export function handWritten() {
  const all = [...CATALOGS.values()].map((t) => Object.keys(t));
  return all.length ? all.reduce((a, b) => a.filter((l) => b.includes(l))) : ["en"];
}

function placeholders(template) {
  return [...String(template).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");
}

// A catalog's English, as a short stable tag: a key added or reworded is a
// new version, and the stored translation of the old one is not used for it.
function versionOf(english) {
  const source = JSON.stringify(Object.entries(english).sort());
  let h = 0x811c9dc5;
  for (let i = 0; i < source.length; i += 1) {
    h ^= source.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
}

function missingIn(name, lang) {
  const tables = CATALOGS.get(name);
  const learned = LEARNED.get(lang)?.get(name) || {};
  return Object.keys(tables.en || {}).filter((k) => tables[lang]?.[k] === undefined && learned[k] === undefined);
}

function learn(lang, name, strings) {
  if (!LEARNED.has(lang)) LEARNED.set(lang, new Map());
  LEARNED.get(lang).set(name, { ...(LEARNED.get(lang).get(name) || {}), ...strings });
}

const SYSTEM_PROMPT = `You translate the interface strings of Honmaru AI, a workplace app where
people route decisions to each other, into one language.

Reply with a JSON object with exactly the keys you were given, each value the
translated string. Keep every {placeholder} exactly as written, untranslated.
Keep "Honmaru", "Honmaru AI" and "[Honmaru]" as they are, and keep → and ·.
Use the tone of a calm, polite work notification.`;

async function translateCatalog(env, lang, english, { orgId }) {
  const provider = orgId ? await providerFor(env, orgId) : providerConfig(env);
  if (!provider) return null;
  try {
    const res = await fetch(provider.endpoint, {
      signal: AbortSignal.timeout(30_000),
      method: "POST",
      headers: { Authorization: `Bearer ${provider.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: provider.model, temperature: 0.1, max_tokens: 4000,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: `Language: ${lang} (${languageName(lang)})\n\n${JSON.stringify(english)}` },
        ],
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    noteUsage(provider, "copy", data);
    const content = data?.choices?.[0]?.message?.content;
    const parsed = JSON.parse(String(content || "").replace(/^```(?:json)?\s*|\s*```$/g, ""));
    const out = {};
    // A string that lost or invented a placeholder is left out: it would put
    // "{name}" on somebody's lock screen, or drop who is waiting.
    for (const [key, source] of Object.entries(english)) {
      const value = parsed?.[key];
      if (typeof value === "string" && value.trim() && placeholders(value) === placeholders(source)) out[key] = value.trim();
    }
    return Object.keys(out).length ? out : null;
  } catch {
    return null;
  } finally {
    if (orgId) await settleUsage(env.DB, provider, { orgId }).catch(() => {});
  }
}

async function ensureCatalog(env, lang, name, opts) {
  if (!missingIn(name, lang).length) return;
  const english = CATALOGS.get(name).en;
  const version = versionOf(english);
  const row = await env.DB
    .prepare("SELECT strings FROM copy_translations WHERE locale = ?1 AND catalog = ?2 AND version = ?3")
    .bind(lang, name, version)
    .first()
    .catch(() => null);
  let stored = {};
  if (row?.strings) {
    try { stored = JSON.parse(row.strings) || {}; } catch { stored = {}; }
    learn(lang, name, stored);
  }
  const missing = missingIn(name, lang);
  if (!missing.length) return;
  const failedAt = FAILED.get(`${lang}:${name}`);
  if (failedAt && Date.now() - failedAt < RETRY_AFTER_MS) return;
  const wanted = Object.fromEntries(missing.map((k) => [k, english[k]]));
  const written = await translateCatalog(env, lang, wanted, opts);
  if (!written) { FAILED.set(`${lang}:${name}`, Date.now()); return; }
  learn(lang, name, written);
  await env.DB
    .prepare(
      `INSERT INTO copy_translations (locale, catalog, version, strings, created_at) VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(locale, catalog) DO UPDATE SET version = ?3, strings = ?4, created_at = ?5`
    )
    .bind(lang, name, version, JSON.stringify({ ...stored, ...written }), new Date().toISOString())
    .run()
    .catch((err) => console.error("copy store failed", err?.message || err));
}

/// Make every catalog speak `locale`, before writing to someone who reads it.
/// Never throws; returns the primary language, which is what lookups take.
/// `orgId` puts the one-off translation on that workspace's model and ledger.
export async function loadCopy(env, locale, { orgId } = {}) {
  const lang = primaryLanguage(locale) || "en";
  if (lang === "en" || !env?.DB || !languageName(lang)) return lang;
  // The catalogs side by side: the first notification in a new language
  // waits for one model call, not three in a row.
  await Promise.all([...CATALOGS.keys()].map((name) => {
    const key = `${lang}:${name}`;
    if (!INFLIGHT.has(key)) {
      INFLIGHT.set(key, ensureCatalog(env, lang, name, { orgId })
        .catch((err) => console.error("copy load failed", err?.message || err))
        .finally(() => INFLIGHT.delete(key)));
    }
    return INFLIGHT.get(key);
  }));
  return lang;
}

/// For tests: every catalog as registered.
export function catalogs() {
  return CATALOGS;
}

/// For tests: forget what was learned in this isolate.
export function forgetLearnedCopy() {
  LEARNED.clear();
  FAILED.clear();
}
