#!/usr/bin/env node
// Measure the router against the golden set.
//
//     node eval/run.mjs                 # the local keyword router, always
//     node eval/run.mjs --model         # and the model, with OPENAI_API_KEY
//     node eval/run.mjs --gate 0.8      # exit 1 when recipient accuracy is below
//     node eval/run.mjs eval/golden.json eval/from-prod.json
//
// The point is a number that moves when the prompt or the router changes.
// Recipient accuracy is the one that matters: a card to the wrong person is
// the failure the product exists to prevent. Type and priority are reported
// but not gated, because reasonable people disagree about them.
//
// Real cards come in through GET /eval/export?orgId=… on the Worker; save the
// `entries` into a file here once someone has confirmed the expectations.

import { readFileSync, writeFileSync } from "node:fs";
import { routeInstruction } from "../src/routing.js";

const args = process.argv.slice(2);
const useModel = args.includes("--model") || Boolean(process.env.EVAL_MODEL);
const gateIndex = args.indexOf("--gate");
const gate = gateIndex >= 0 ? Number(args[gateIndex + 1]) : null;
const files = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--gate");
if (files.length === 0) files.push(new URL("./golden.json", import.meta.url).pathname);

const orgs = {};
const entries = [];
for (const file of files) {
  const set = JSON.parse(readFileSync(file, "utf8"));
  Object.assign(orgs, set.orgs || {});
  for (const e of set.entries || []) entries.push(e);
}

const provider = useModel && process.env.OPENAI_API_KEY
  ? {
      apiKey: process.env.OPENAI_API_KEY,
      endpoint: process.env.OPENAI_ENDPOINT || "https://api.openai.com/v1/chat/completions",
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      providerName: "openai",
    }
  : null;
if (useModel && !provider) {
  console.error("--model needs OPENAI_API_KEY in the environment");
  process.exit(2);
}

function score(result, expect) {
  const fields = {};
  for (const [key, want] of Object.entries(expect || {})) {
    if (want === null || want === undefined) continue;
    const got = key === "business" ? result.business : result[key];
    fields[key] = got === want;
  }
  return fields;
}

async function runOne(entry, openRouter) {
  const org = orgs[entry.org];
  if (!org) throw new Error(`${entry.id}: unknown org fixture "${entry.org}"`);
  const sender = { ...entry.sender, name: entry.sender.name || entry.sender.id };
  const result = await routeInstruction({
    text: entry.text,
    sender,
    organization: org,
    readerLanguage: entry.readerLanguage || "en",
    senderContext: entry.senderContext,
    teamContext: entry.teamContext,
    openRouter: openRouter || undefined,
  });
  return {
    id: entry.id,
    text: entry.text,
    routedBy: result.routedBy,
    got: {
      recipientUserID: result.recipientUserID,
      cardType: result.cardType,
      priority: result.priority,
      business: result.business || null,
    },
    expect: entry.expect,
    fields: score(result, entry.expect),
  };
}

function summarize(rows) {
  const totals = {};
  for (const row of rows) {
    for (const [field, ok] of Object.entries(row.fields)) {
      totals[field] ||= { ok: 0, n: 0 };
      totals[field].n += 1;
      if (ok) totals[field].ok += 1;
    }
  }
  return Object.fromEntries(
    Object.entries(totals).map(([field, t]) => [field, { ...t, accuracy: t.n ? t.ok / t.n : null }])
  );
}

function print(label, rows) {
  const summary = summarize(rows);
  console.log(`\n== ${label} (${rows.length} entries) ==`);
  for (const row of rows) {
    const marks = Object.entries(row.fields).map(([f, ok]) => `${ok ? "✓" : "✗"} ${f}`).join("  ");
    const misses = Object.entries(row.fields).filter(([, ok]) => !ok).map(([f]) => `${f}: got ${row.got[f]} want ${row.expect[f]}`);
    console.log(`${row.id}  ${marks}${misses.length ? `   (${misses.join("; ")})` : ""}`);
  }
  console.log("");
  for (const [field, t] of Object.entries(summary)) {
    console.log(`${field.padEnd(16)} ${t.ok}/${t.n}  ${(t.accuracy * 100).toFixed(0)}%`);
  }
  return summary;
}

const local = [];
for (const entry of entries) local.push(await runOne(entry, null));
const localSummary = print("local router", local);

let modelSummary = null;
let model = [];
if (provider) {
  for (const entry of entries) model.push(await runOne(entry, provider));
  modelSummary = print(`model ${provider.model}`, model);
}

writeFileSync(
  new URL("./last-run.json", import.meta.url),
  JSON.stringify({ at: new Date().toISOString(), files, local: { rows: local, summary: localSummary }, model: provider ? { model: provider.model, rows: model, summary: modelSummary } : null }, null, 2)
);

if (gate !== null) {
  const measured = (modelSummary || localSummary).recipientUserID?.accuracy ?? 0;
  if (measured < gate) {
    console.error(`\nrecipient accuracy ${(measured * 100).toFixed(0)}% is below the gate of ${(gate * 100).toFixed(0)}%`);
    process.exit(1);
  }
}
