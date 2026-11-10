import { aad, openField } from './secrets.js';
import { PRICES } from './ledger.js';

// A workspace-wide guard for model usage that is paid by this deployment.
// Amounts use the ledger's estimated list prices, never provider invoices or
// Kylon credits. BYOK calls and external-tool charges are intentionally out
// of scope.

const DAY = 86_400_000;
const WINDOWS = [
  ['24h', 'daily_budget_micros', DAY],
  ['7d', 'weekly_budget_micros', 7 * DAY],
  ['30d', 'monthly_budget_micros', 30 * DAY],
];

const usd = (micros) => Math.round((Number(micros) || 0)) / 1_000_000;
// The ledger applies a fallback price to unknown model names for reporting.
// Workspace pause decisions are stricter: that fallback may be lower than a
// newly introduced model's real list price, so it cannot prove the configured
// cap was respected. Explicit per-search and Jev entries have their own known
// non-token pricing and remain trusted.
const knownModelPredicate = `lower(model) IN ('web_search','jev-latest') OR ${Object.keys(PRICES)
  .map((model) => `substr(lower(model),1,${model.length})='${model}'`).join(' OR ')}`;

export async function workspaceAIBudgetStatus(db, orgId, now = Date.now(), savedSettings = null) {
  if (!db || !orgId) return null;
  const settings = savedSettings && !savedSettings.settingsReadFailed ? savedSettings : await db.prepare(`SELECT daily_budget_micros,weekly_budget_micros,monthly_budget_micros,
    budget_action,budget_revision FROM org_ai_settings WHERE org_id=?1`).bind(orgId).first();
  const config = settings || {};
  const since = new Date(now - 30 * DAY).toISOString();
  const at = new Date(now).toISOString();
  const usage = await db.prepare(`SELECT
    COALESCE(SUM(CASE WHEN created_at>=?2 THEN MAX(0,ROUND(usd*1000000)) ELSE 0 END),0) AS d24,
    COALESCE(SUM(CASE WHEN created_at>=?3 THEN MAX(0,ROUND(usd*1000000)) ELSE 0 END),0) AS d7,
    COALESCE(SUM(MAX(0,ROUND(usd*1000000))),0) AS d30,
    SUM(CASE WHEN created_at>=?2 THEN 1 ELSE 0 END) AS c24,
    SUM(CASE WHEN created_at>=?3 THEN 1 ELSE 0 END) AS c7,
    COUNT(*) AS c30,
    SUM(CASE WHEN created_at>=?2 AND NOT (${knownModelPredicate}) THEN 1 ELSE 0 END) AS u24,
    SUM(CASE WHEN created_at>=?3 AND NOT (${knownModelPredicate}) THEN 1 ELSE 0 END) AS u7,
    SUM(CASE WHEN NOT (${knownModelPredicate}) THEN 1 ELSE 0 END) AS u30
    FROM ai_calls WHERE org_id=?1 AND byok=0 AND created_at>=?4 AND created_at<=?5`)
    .bind(orgId, new Date(now - DAY).toISOString(), new Date(now - 7 * DAY).toISOString(), since, at).first();
  const values = { '24h': [usage?.d24, usage?.c24, usage?.u24, config.daily_budget_micros], '7d': [usage?.d7, usage?.c7, usage?.u7, config.weekly_budget_micros], '30d': [usage?.d30, usage?.c30, usage?.u30, config.monthly_budget_micros] };
  const periods = Object.fromEntries(Object.entries(values).map(([key, [used, calls, unpriced, limit]]) => {
    const usedMicros = Math.max(0, Math.round(Number(used) || 0));
    const limitMicros = Math.max(0, Math.round(Number(limit) || 0));
    const unpricedCalls = Math.max(0, Number(unpriced) || 0);
    return [key, { usedMicros, usedUsd: usd(usedMicros), calls: Number(calls) || 0,
      limitMicros, limitUsd: usd(limitMicros), exhausted: limitMicros > 0 && usedMicros >= limitMicros,
      unpricedCalls, indeterminate: limitMicros > 0 && unpricedCalls > 0,
      warning: limitMicros > 0 && usedMicros >= limitMicros * 0.8 }];
  }));
  return { revision: Number(config.budget_revision) || 0,
    action: config.budget_action === 'pause' ? 'pause' : 'warn',
    source: 'deployment-key-recorded-list-price', periods };
}

export function workspaceAIBudgetExceeded(status) {
  if (!status || status.action !== 'pause') return false;
  return WINDOWS.some(([key]) => status.periods?.[key]?.limitMicros > 0
    && (status.periods?.[key]?.exhausted || status.periods?.[key]?.indeterminate));
}

/// One in-app notice per saved budget revision. A failed request can be
/// retried many times (or by many members); only the first request that sees
/// an exceeded pause budget claims the notice. Updating the budget creates a
/// new revision and allows one new notice if that configuration is later hit.
export async function claimWorkspaceBudgetNotice(db, orgId, status, now = new Date().toISOString()) {
  if (!db || !orgId || !workspaceAIBudgetExceeded(status)) return null;
  const periods = WINDOWS.filter(([key]) => {
    const period = status.periods?.[key];
    return Number(period?.limitMicros) > 0 && (period.exhausted || period.indeterminate);
  }).map(([key]) => key);
  if (!periods.length) return null;
  const revision = Number(status.revision) || 0;
  const claimed = await db.prepare(`UPDATE org_ai_settings SET budget_notified_revision=?2
    WHERE org_id=?1 AND budget_revision=?2 AND budget_notified_revision<?2`)
    .bind(orgId, revision).run();
  if (!claimed.meta?.changes) return null;
  const { results } = await db.prepare(`SELECT u.login FROM memberships m JOIN users u ON u.github_id=m.user_github_id
    WHERE m.org_id=?1 AND LOWER(TRIM(m.role)) IN ('owner','admin') AND u.login IS NOT NULL ORDER BY m.created_at,m.user_github_id`)
    .bind(orgId).all();
  const logins = [...new Set((results || []).map((row) => String(row.login || '').trim()).filter(Boolean))];
  return { revision, periods, logins, createdAt: now };
}

// Harness side effects that can continue work after a model request has
// already reached the workspace's pause threshold share the same stop. This
// does not estimate or meter external-provider/connector charges. A workspace
// OpenAI key remains the workspace's own bill and bypasses this deployment
// budget, matching allowanceFor.
export async function workspaceBudgetAdmission(db, orgId, now = Date.now(), { ignoreWorkspaceKey = false } = {}) {
  if (!db || !orgId) return { allowed: true };
  try {
    const settings = await db.prepare(`SELECT openai_key,daily_budget_micros,weekly_budget_micros,monthly_budget_micros,
      budget_action,budget_revision FROM org_ai_settings WHERE org_id=?1`).bind(orgId).first();
    if (!ignoreWorkspaceKey && settings?.openai_key) {
      let workspaceKey = null;
      try { workspaceKey = await openField(settings.openai_key, aad.aiKey(orgId, 'openai_key'), orgId); } catch {}
      if (workspaceKey) return { allowed: true, source: 'workspace-key' };
    }
    const status = await workspaceAIBudgetStatus(db, orgId, now, settings || {});
    if (!workspaceAIBudgetExceeded(status)) return { allowed: true, status };
    const hasUnpriced = WINDOWS.some(([key]) => status.periods?.[key]?.limitMicros > 0 && status.periods?.[key]?.indeterminate);
    return {
      allowed: false,
      reason: 'workspace_ai_budget',
      status: 409,
      budget: status,
      message: hasUnpriced
        ? "The workspace AI usage includes a model without a known list price, so its configured usage limit cannot be verified. An admin can change the limit; the window clears as older usage ages out."
        : "The workspace's estimated AI usage limit has been reached. An admin can raise the limit; the window also clears as older usage ages out.",
    };
  } catch (err) {
    console.error('workspace AI budget admission check failed', err?.message || err);
    return {
      allowed: false,
      reason: 'workspace_ai_budget_unavailable',
      status: 503,
      message: 'The workspace AI usage limit could not be checked. Try again shortly.',
    };
  }
}

export async function saveWorkspaceAIBudget(db, orgId, input, byGithubId, now = new Date().toISOString()) {
  const current = await db.prepare(`SELECT budget_revision,daily_budget_micros,weekly_budget_micros,monthly_budget_micros,
    budget_action FROM org_ai_settings WHERE org_id=?1`).bind(orgId).first();
  const revision = Number(current?.budget_revision) || 0;
  if (!Number.isSafeInteger(input.revision) || input.revision !== revision) {
    return { error: 'The workspace AI settings changed. Reload before saving its usage limit.', status: 409 };
  }
  const fields = [input.dailyLimitUsd, input.weeklyLimitUsd, input.monthlyLimitUsd];
  const previous = [current?.daily_budget_micros, current?.weekly_budget_micros, current?.monthly_budget_micros];
  const micros = fields.map((value, index) => {
    const amount = value === undefined ? usd(previous[index]) : Number(value);
    const converted = amount * 1_000_000;
    if (!Number.isFinite(amount) || amount < 0 || amount > 1_000_000 || Math.abs(converted - Math.round(converted)) >= 0.001) return null;
    return Math.round(converted);
  });
  if (micros.some((value) => value === null)) return { error: 'Usage limits must be USD amounts from 0 to 1,000,000 with up to six decimal places. Use 0 for no limit.', status: 400 };
  const action = input.action === undefined ? (current?.budget_action === 'pause' ? 'pause' : 'warn') : input.action;
  if (!['warn', 'pause'].includes(action)) return { error: 'Choose whether to warn or stop new AI requests when a usage limit is reached.', status: 400 };
  const result = await db.prepare(`INSERT INTO org_ai_settings
    (org_id,daily_budget_micros,weekly_budget_micros,monthly_budget_micros,budget_action,budget_revision,updated_by,updated_at)
    VALUES (?1,?2,?3,?4,?5,1,?6,?7)
    ON CONFLICT(org_id) DO UPDATE SET daily_budget_micros=excluded.daily_budget_micros,
      weekly_budget_micros=excluded.weekly_budget_micros,monthly_budget_micros=excluded.monthly_budget_micros,
      budget_action=excluded.budget_action,budget_revision=org_ai_settings.budget_revision+1,
      updated_by=excluded.updated_by,updated_at=excluded.updated_at
    WHERE org_ai_settings.budget_revision=?8`)
    .bind(orgId, ...micros, action, String(byGithubId), now, revision).run();
  if (!result.meta?.changes) return { error: 'The workspace AI settings changed. Reload before saving its usage limit.', status: 409 };
  return { status: await workspaceAIBudgetStatus(db, orgId) };
}
