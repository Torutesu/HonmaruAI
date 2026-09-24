// What a workspace runs its AI on — chosen from the Tools screen, not from a
// deploy.
//
// The Worker's own secrets (OPENAI_API_KEY, TYPESAFE_API_KEY, OPENAI_MODEL)
// are the deployment's floor: what every workspace gets when its admins have
// said nothing. A workspace can set its own on top — the model it pays for,
// a key of its own so the bill is theirs, System One switched on for its
// routing — and a person's own key, sent per request, wins over both. Keys
// live in D1 the way connector tokens already do; they are never returned,
// only whether one is set and its last four characters.

import { providerConfig } from "./provider.js";
import { jevConfig } from "./jev.js";
import { PRICES } from "./ledger.js";

/// The models a workspace may pick, with what they cost per million tokens
/// (in, out) — the same table the ledger prices calls from.
export const MODELS = ["gpt-4o-mini", "gpt-4.1-nano", "gpt-4.1-mini", "gpt-4o", "gpt-4.1", "gpt-5-mini", "gpt-5-nano"]
  .map((id) => ({ id, priceIn: PRICES[id][0], priceOut: PRICES[id][1] }));

const settingsCache = new WeakMap();

export async function loadAISettings(db, orgId) {
  if (!db || !orgId) return {};
  const row = await db
    .prepare("SELECT model, openai_key, typesafe_key, updated_by, updated_at FROM org_ai_settings WHERE org_id = ?1")
    .bind(orgId)
    .first()
    .catch(() => null);
  if (!row) return {};
  return {
    model: row.model || null,
    openaiKey: row.openai_key || null,
    typesafeKey: row.typesafe_key || null,
    updatedBy: row.updated_by || null,
    updatedAt: row.updated_at || null,
  };
}

const KEY_MAX = 300;
const looksLikeKey = (k) => typeof k === "string" && k.trim().length >= 16 && k.trim().length <= KEY_MAX && !/\s/.test(k.trim());

/// Change what the workspace runs on. `null` for a key removes it; leaving a
/// field out leaves it alone; an empty model means "the deployment's".
export async function saveAISettings(db, orgId, { model, openaiKey, typesafeKey }, byGithubId) {
  const current = await loadAISettings(db, orgId);
  let nextModel = current.model || null;
  if (model !== undefined) {
    if (model === null || model === "") nextModel = null;
    else if (!MODELS.some((m) => m.id === model)) return { error: "That is not one of the models you can pick." };
    else nextModel = model;
  }
  let nextOpenai = current.openaiKey || null;
  if (openaiKey !== undefined) {
    if (openaiKey === null || openaiKey === "") nextOpenai = null;
    else if (!looksLikeKey(openaiKey) || !openaiKey.trim().startsWith("sk-")) return { error: "That does not look like an OpenAI key (they start with sk-)." };
    else nextOpenai = openaiKey.trim();
  }
  let nextTypesafe = current.typesafeKey || null;
  if (typesafeKey !== undefined) {
    if (typesafeKey === null || typesafeKey === "") nextTypesafe = null;
    else if (!looksLikeKey(typesafeKey)) return { error: "That does not look like a TypeSafe API key." };
    else nextTypesafe = typesafeKey.trim();
  }
  await db
    .prepare(
      `INSERT INTO org_ai_settings (org_id, model, openai_key, typesafe_key, updated_by, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT(org_id) DO UPDATE SET model = excluded.model, openai_key = excluded.openai_key,
         typesafe_key = excluded.typesafe_key, updated_by = excluded.updated_by, updated_at = excluded.updated_at`
    )
    .bind(orgId, nextModel, nextOpenai, nextTypesafe, String(byGithubId), new Date().toISOString())
    .run();
  return { ok: true };
}

/// The provider for one workspace's call. A person's own key first, then
/// the workspace's, then the deployment's. A workspace key is its own bill,
/// so the ledger is told it is not ours.
export async function providerFor(env, orgId, userKey) {
  const settings = orgId ? await loadAISettings(env.DB, orgId) : {};
  const scoped = {
    ...env,
    OPENAI_API_KEY: settings.openaiKey || env.OPENAI_API_KEY,
    OPENAI_MODEL: settings.model || env.OPENAI_MODEL,
  };
  const provider = providerConfig(scoped, userKey);
  if (provider && !userKey && settings.openaiKey) provider.byok = true;
  return provider;
}

/// System One for one workspace: its own key, or the deployment's.
export async function jevFor(env, orgId) {
  const settings = orgId ? await loadAISettings(env.DB, orgId) : {};
  return jevConfig({ ...env, TYPESAFE_API_KEY: settings.typesafeKey || env.TYPESAFE_API_KEY });
}

const hint = (key) => (key ? `…${String(key).slice(-4)}` : null);

/// What the Tools screen shows: what runs, where each piece comes from, and
/// what an admin may change. No key ever leaves here.
export async function aiStatus(env, orgId) {
  const settings = await loadAISettings(env.DB, orgId);
  const provider = await providerFor(env, orgId);
  const jev = await jevFor(env, orgId);
  return {
    // The chosen model, even before a key exists to run it on: the choice
    // is the workspace's, the key can come after.
    model: settings.model || provider?.model || env.OPENAI_MODEL || (env.OPENAI_API_KEY ? "gpt-4o-mini" : null),
    modelSource: settings.model ? "workspace" : (provider ? "deployment" : "none"),
    provider: provider?.providerName || null,
    openai: settings.openaiKey ? "workspace" : (env.OPENAI_API_KEY ? "deployment" : "none"),
    openaiHint: hint(settings.openaiKey),
    systemOne: Boolean(jev),
    jev: settings.typesafeKey ? "workspace" : (env.TYPESAFE_API_KEY ? "deployment" : "none"),
    jevHint: hint(settings.typesafeKey),
    models: MODELS,
    updatedAt: settings.updatedAt || null,
  };
}
