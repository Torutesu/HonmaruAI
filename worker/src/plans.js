// What there is to buy, and what this account currently has.
//
// The prices live here rather than in the client because two clients read
// them (the web app and iOS) and a price that disagrees between them is worse
// than no price at all. The App Store is still the seller on iOS — this is the
// catalog and the current standing, not a checkout.

import { isPro } from "./entitlements.js";
import { usedToday } from "./db.js";
import { FREE_DAILY_ROUTES, UNBILLED_DAILY_ROUTES } from "./gate.js";

// Three days, which is long enough to have a real decision routed to someone
// else and get an answer back — the thing the product is for.
export const TRIAL_DAYS = 3;

export const PLANS = [
  {
    id: "free",
    name: "Free",
    monthly: 0,
    annualMonthly: 0,
    tagline: "See how it works",
    features: [
      `${FREE_DAILY_ROUTES} AI-routed decisions a day`,
      "Unlimited decisions with your own AI key",
      "Notifications in your language",
    ],
  },
  {
    id: "pro",
    name: "Pro",
    monthly: 10,
    annualMonthly: 8,
    tagline: "For one person running several things",
    features: [
      "Unlimited AI routing",
      "Every business, filed automatically",
      "The record: every decision, written by nobody",
      "Priority notification delivery",
    ],
  },
  {
    id: "business",
    name: "Business",
    monthly: 15,
    annualMonthly: 12,
    perSeat: true,
    tagline: "For a team of under ten running ten businesses",
    features: [
      "Everything in Pro, per person",
      "Shared org graph and roles",
      "Gmail, Slack and Notion connectors",
      "GitHub sync for decisions and tasks",
    ],
  },
];

/// The catalog plus where this account stands in it.
///
/// `purchasable` is false wherever billing has no credentials — the honest
/// answer, and the one that lets the client show the plans without offering a
/// button that cannot do anything.
export async function billingStatus(env, githubId) {
  const purchasable = Boolean(env.REVENUECAT_SECRET_KEY);
  const pro = await isPro(env, githubId);
  const used = await usedToday(env.DB, githubId, new Date().toISOString().slice(0, 10));
  // The ceiling actually in force, which is not the free tier's when there is
  // no upgrade to sell: `checkAIAllowance` meters an unbilled deployment
  // against a much higher bound. Reporting three here would have the screen
  // warn people about a limit nothing was enforcing.
  const ceiling = purchasable ? FREE_DAILY_ROUTES : UNBILLED_DAILY_ROUTES;
  return {
    plan: pro ? "pro" : "free",
    pro,
    purchasable,
    trialDays: TRIAL_DAYS,
    freeDailyRoutes: FREE_DAILY_ROUTES,
    dailyLimit: ceiling,
    usedToday: used,
    remainingToday: pro ? null : Math.max(0, ceiling - used),
    currency: "USD",
    plans: PLANS,
  };
}
