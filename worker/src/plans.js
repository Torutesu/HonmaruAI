// StoreKit is the source of truth for prices, periods, and offer eligibility.
// The web shows account access and directs paid purchases to the iOS app.
import { isPro } from "./entitlements.js";
import { hasComplimentaryAccess, complimentaryAvailable, ensureComplimentarySynced } from "./complimentary.js";
import { usedToday } from "./db.js";
import { FREE_DAILY_ROUTES, UNBILLED_DAILY_ROUTES } from "./gate.js";
import { loadAISettings } from "./orgAI.js";

export const PLANS = [
  {
    id: "free",
    name: "Free",
    available: true,
    features: [
      `${FREE_DAILY_ROUTES} AI-routed decisions a day`,
      "Unlimited decisions with your own AI key",
      "Notifications in your language",
    ],
  },
  {
    id: "pro",
    name: "Pro",
    available: true,
    features: [
      "Unlimited AI routing",
      "Every business, filed automatically",
      "Every connector: Gmail, Slack, Notion, Calendar, Drive",
      "The record: every decision, written by nobody",
    ],
    purchasePlatform: "app_store",
  },
];

export async function billingStatus(env, githubId, orgId) {
  const purchasable = Boolean(env.REVENUECAT_SECRET_KEY);
  // A workspace on its own key is never metered: its bill is its own.
  let workspaceKey = false;
  if (orgId) {
    try { workspaceKey = Boolean((await loadAISettings(env.DB, orgId)).openaiKey); } catch { workspaceKey = false; }
  }
  const complimentary = await hasComplimentaryAccess(env, githubId);
  const complimentarySyncPending = complimentary && !(await ensureComplimentarySynced(env, githubId));
  const pro = complimentary || await isPro(env, githubId);
  const used = await usedToday(env.DB, githubId, new Date().toISOString().slice(0, 10));
  const ceiling = purchasable ? FREE_DAILY_ROUTES : UNBILLED_DAILY_ROUTES;
  return {
    plan: pro ? "pro" : "free",
    pro,
    purchasable,
    purchasePlatform: "app_store",
    accessSource: complimentary ? "complimentary" : pro ? "subscription" : workspaceKey ? "workspace" : "free",
    workspaceKey,
    complimentary,
    complimentarySyncPending,
    complimentaryAvailable: complimentaryAvailable(env),
    freeDailyRoutes: FREE_DAILY_ROUTES,
    dailyLimit: ceiling,
    usedToday: used,
    remainingToday: pro || workspaceKey ? null : Math.max(0, ceiling - used),
    plans: PLANS,
  };
}
