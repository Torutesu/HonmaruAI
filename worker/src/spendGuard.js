// A brake on the database bill.
//
// Workers Paid bills D1 by the row, with no ceiling: a loop that writes a
// row a request, or a sync gone round in circles, is a bill nobody notices
// until the month ends. Every fifteen minutes this asks Cloudflare how many
// rows the database has written and read today (the GraphQL analytics API)
// and compares them with two lines:
//
//   warn  D1_DAILY_WRITE_WARN, default 3M rows written (twice what a month's
//         allowance spread over its days comes to): ALERT_WEBHOOK_URL is told.
//   stop  D1_DAILY_WRITE_STOP, default 10M: the work nobody is waiting on —
//         connector syncs, routines, the Durable Object reconcile, sealing
//         old rows — stops until the next UTC day, and the alert says so.
//         What people do keeps working: the brake never refuses a request.
//
// Reads have their own lines (D1_DAILY_READ_WARN / _STOP, 2B and 10B).
//
// It needs CF_ANALYTICS_TOKEN (Account Analytics: Read), CF_ACCOUNT_ID and
// D1_DATABASE_ID; without them it does nothing. SPEND_GUARD=off turns the
// brake off (the warning stays).

import { alert } from "./alert.js";

const DEFAULTS = { writeWarn: 3_000_000, writeStop: 10_000_000, readWarn: 2_000_000_000, readStop: 10_000_000_000 };
const KEY = (day) => `spend-brake:${day}`;
const today = (now) => new Date(now).toISOString().slice(0, 10);

const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);

export function limitsOf(env) {
  return {
    writeWarn: num(env.D1_DAILY_WRITE_WARN, DEFAULTS.writeWarn),
    writeStop: num(env.D1_DAILY_WRITE_STOP, DEFAULTS.writeStop),
    readWarn: num(env.D1_DAILY_READ_WARN, DEFAULTS.readWarn),
    readStop: num(env.D1_DAILY_READ_STOP, DEFAULTS.readStop),
  };
}

/// Rows read and written today (UTC), from Cloudflare's analytics, or null.
export async function usageToday(env, now = Date.now()) {
  if (!env.CF_ANALYTICS_TOKEN || !env.CF_ACCOUNT_ID || !env.D1_DATABASE_ID) return null;
  const day = today(now);
  const query = `query ($account: String!, $db: String!, $day: Date!) {
    viewer { accounts(filter: { accountTag: $account }) {
      d1AnalyticsAdaptiveGroups(limit: 1, filter: { date: $day, databaseId: $db }) { sum { rowsRead rowsWritten } }
    } } }`;
  const res = await fetch("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: { authorization: `Bearer ${env.CF_ANALYTICS_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ query, variables: { account: env.CF_ACCOUNT_ID, db: env.D1_DATABASE_ID, day } }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`analytics answered ${res.status}`);
  const data = await res.json();
  if (data.errors?.length) throw new Error(String(data.errors[0]?.message || "analytics error"));
  const sum = data.data?.viewer?.accounts?.[0]?.d1AnalyticsAdaptiveGroups?.[0]?.sum || {};
  return { day, written: Number(sum.rowsWritten) || 0, read: Number(sum.rowsRead) || 0 };
}

/// Every fifteen minutes: today's usage against the lines. Returns what it
/// found and did.
export async function checkSpend(env, ctx, { now = Date.now() } = {}) {
  const usage = await usageToday(env, now);
  if (!usage) return { checked: false };
  const lim = limitsOf(env);
  const over = usage.written >= lim.writeStop || usage.read >= lim.readStop;
  const warn = usage.written >= lim.writeWarn || usage.read >= lim.readWarn;
  const brakeOn = String(env.SPEND_GUARD || "").toLowerCase() !== "off";
  const said = `D1 today: ${usage.written.toLocaleString("en")} rows written, ${usage.read.toLocaleString("en")} read`;
  if (over && brakeOn) {
    const already = await env.DB.prepare("SELECT 1 FROM kv WHERE key = ?1").bind(KEY(usage.day)).first().catch(() => null);
    if (!already) {
      await env.DB.prepare("INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?1, ?2, ?3)")
        .bind(KEY(usage.day), JSON.stringify(usage), new Date(now).toISOString()).run();
      cached = null;
    }
    alert(ctx, env, "spend-brake", `${said}. Past the stop line: background work is paused until 00:00 UTC. Find the writer (Cloudflare → D1 → Metrics).`);
    return { checked: true, usage, braked: true };
  }
  if (warn) alert(ctx, env, "spend-warning", `${said}. Past the warning line.`);
  return { checked: true, usage, warned: warn, braked: false };
}

let cached = null; // { day, on, at }

/// Whether the brake is on today. Cached for a minute.
export async function braked(env, now = Date.now()) {
  if (String(env.SPEND_GUARD || "").toLowerCase() === "off") return false;
  const day = today(now);
  if (cached && cached.day === day && now - cached.at < 60_000) return cached.on;
  const row = await env.DB.prepare("SELECT 1 AS on_ FROM kv WHERE key = ?1").bind(KEY(day)).first().catch(() => null);
  cached = { day, on: Boolean(row), at: now };
  return cached.on;
}

export function forgetBrake() { cached = null; }
