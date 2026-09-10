// What there is to buy, and what this account currently has.
//
// The prices live here rather than in the client because two clients read
// them (the web app and iOS) and a price that disagrees between them is worse
// than no price at all. The App Store is still the seller on iOS — this is the
// catalog and the current standing, not a checkout.
//
// Which is exactly why every line of it has to be true. A price list is the
// one screen where a claim the code does not honour is not a rough edge, and
// there were two here: Pro advertised "Priority notification delivery", and
// nothing anywhere delivers a paying subscriber's notification differently —
// urgency is read off the card, never off the payer. And Business was priced,
// listed and selectable although nothing sells it. `available` marks the tiers
// a person can actually buy today.

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
    available: true,
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
    available: true,
    tagline: "For one person running several things",
    features: [
      "Unlimited AI routing",
      "Every business, filed automatically",
      "Every connector: Gmail, Slack, Notion, Calendar, Drive",
      "The record: every decision, written by nobody",
    ],
  },
  {
    id: "business",
    name: "Business",
    monthly: 15,
    annualMonthly: 12,
    perSeat: true,
    // Nothing sells this. There is one entitlement in RevenueCat — `honmaruai
    // Pro` — and one pair of store products behind it, so a person who picked
    // Business was shown a price, a trial and a button for a tier that could
    // not be bought and would have unlocked nothing if it had been. It stays
    // in the catalog because it is where per-seat billing is going, and it
    // says so now rather than pretending.
    available: false,
    tagline: "For a team of under ten running ten businesses",
    features: [
      "Everything in Pro, per person",
      "One bill for the whole team",
      "Seats you can add and remove yourself",
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
