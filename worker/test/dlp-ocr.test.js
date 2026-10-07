import { env } from "cloudflare:test";
import { fetchMock } from "./helpers/fetch-mock.js";
import { afterEach, beforeEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import worker from "../src/index.js";
import { pdfContents } from "../src/pdfText.js";

// Pictures read for the data rules (ocr.js): off until an admin turns it
// on; then a photo, or a PDF of scanned pages, goes to the workspace's model
// to be read, and what it says is checked like any other file.

const ORG = "personal:ocr";
let toru; let mika;
const pending = [];
const ctx = { waitUntil: (p) => pending.push(p) };
const AI = { ...env, OPENAI_API_KEY: "sk-test" };
const call = async (path, token, { method = "GET", body } = {}) => {
  const res = await worker.fetch(new Request("https://example.com" + path, {
    method, headers: { "content-type": "application/json", "x-session-token": token }, ...(body ? { body: JSON.stringify(body) } : {}),
  }), AI, ctx);
  while (pending.length) await pending.shift();
  return res;
};
const post = (token, text, extra = {}) => call("/channels/messages", token, { method: "POST", body: { orgId: ORG, channel: "b:cafe", body: text, ...extra } });
const lengthOf = (bytes) => (typeof bytes === "string" ? new TextEncoder().encode(bytes).byteLength : bytes.byteLength);
const upload = async (token, bytes, type, name) => {
  const res = await worker.fetch(new Request(`https://example.com/channels/files?orgId=${encodeURIComponent(ORG)}&channel=b:cafe&name=${encodeURIComponent(name)}`, {
    method: "POST", headers: { "content-type": type, "x-session-token": token, "content-length": String(lengthOf(bytes)) }, body: bytes,
  }), AI, ctx);
  while (pending.length) await pending.shift();
  expect(res.status).toBe(201);
  return (await res.json()).file.id;
};
/// The model, reading: what it was sent is kept in `seen`.
const seen = [];
const reads = (text, status = 200) => fetchMock.get("https://api.openai.com").intercept({ path: "/v1/chat/completions", method: "POST" })
  .reply(status, (opts) => { seen.push(JSON.parse(opts.body)); return { model: "gpt-4o-mini", usage: { prompt_tokens: 900, completion_tokens: 20 }, choices: [{ message: { content: text } }] }; });

const latin = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);
const JPEG = latin("\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00" + "scan".repeat(40) + "\xff\xd9");
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);

/// A PDF whose one page is a picture: a scanner's.
function scannedPdf({ words = "" } = {}) {
  const content = `q 595 0 0 842 0 0 cm /Im1 Do Q${words ? ` BT /F1 12 Tf 72 700 Td (${words}) Tj ET` : ""}`;
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /Resources << /XObject << /Im1 4 0 R >> /Font << /F1 6 0 R >> >> /Contents 5 0 R >>",
    { dict: "/Type /XObject /Subtype /Image /Width 2480 /Height 3508 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode", data: JPEG },
    { dict: "", data: latin(content) },
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const parts = [latin("%PDF-1.4\n")];
  objs.forEach((o, i) => {
    if (typeof o === "string") parts.push(latin(`${i + 1} 0 obj\n${o}\nendobj\n`));
    else parts.push(latin(`${i + 1} 0 obj\n<< ${o.dict} /Length ${o.data.length} >>\nstream\n`), o.data, latin("\nendstream\nendobj\n"));
  });
  parts.push(latin(`trailer\n<< /Root 1 0 R /Size ${objs.length + 1} >>\n%%EOF\n`));
  return new Blob(parts).arrayBuffer();
}

beforeEach(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  await env.DB.exec("DELETE FROM dlp_rules; DELETE FROM dlp_settings; DELETE FROM audit_events; DELETE FROM rate_limits; DELETE FROM ai_calls;");
  const { createSession, upsertUser, upsertMembership, upsertBusiness } = await import("../src/db.js");
  for (const [id, login, name, role] of [["9201", "toru", "Toru", "admin"], ["9202", "mika", "Mika", "member"]]) {
    await upsertUser(env.DB, { githubId: id, login, name, avatarUrl: null, locale: "en" });
    await upsertMembership(env.DB, ORG, id, role);
  }
  await upsertBusiness(env.DB, ORG, { name: "Cafe", createdBy: "9201" });
  toru = await createSession(env.DB, "9201", "x");
  mika = await createSession(env.DB, "9202", "y");
  await call("/orgs/dlp", toru, { method: "POST", body: { orgId: ORG, kind: "builtin", detector: "credit_card", action: "block" } });
  seen.length = 0;
  fetchMock.activate();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

test("a scanned page's JPEG is handed back only when the page has no words of its own", async () => {
  const scan = await pdfContents(await scannedPdf(), { pictures: true });
  expect(scan.images).toHaveLength(1);
  expect(scan.images[0]).toMatchObject({ type: "image/jpeg" });
  expect(Array.from(scan.images[0].bytes.subarray(0, 2))).toEqual([0xff, 0xd8]);
  expect((await pdfContents(await scannedPdf(), { pictures: false })).images).toEqual([]);
  const typed = await pdfContents(await scannedPdf({ words: "A page with its own words on it" }), { pictures: true });
  expect(typed.images).toEqual([]);
  expect(typed.text).toContain("its own words");
});

test("pictures are not read until an admin turns it on, and only an admin can", async () => {
  const before = await (await call(`/orgs/dlp?orgId=${encodeURIComponent(ORG)}`, toru)).json();
  expect(before.pictures).toEqual({ on: false, available: true });
  // Off: nothing is sent to the model, and the picture goes.
  const png = await upload(mika, PNG, "image/png", "card.png");
  expect((await post(mika, "my card", { files: [png] })).status).toBe(201);
  expect(seen).toHaveLength(0);

  expect((await call("/orgs/dlp/settings", mika, { method: "PUT", body: { orgId: ORG, readPictures: true } })).status).toBe(403);
  expect((await call("/orgs/dlp/settings", toru, { method: "PUT", body: { orgId: ORG, readPictures: "yes" } })).status).toBe(400);
  const on = await call("/orgs/dlp/settings", toru, { method: "PUT", body: { orgId: ORG, readPictures: true } });
  expect(await on.json()).toEqual({ pictures: { on: true, available: true } });
  const logged = await env.DB.prepare("SELECT * FROM audit_events WHERE org_id = ?1 AND action = 'dlp.settings_changed'").bind(ORG).first();
  expect(logged).toBeTruthy();
});

test("with it on, a photo of a card and a scanned PDF of one are both stopped, and the reading is billed", async () => {
  await call("/orgs/dlp/settings", toru, { method: "PUT", body: { orgId: ORG, readPictures: true } });

  reads("VISA\n4111 1111 1111 1111\nKEN SATO");
  const png = await upload(mika, PNG, "image/png", "card.png");
  const blocked = await post(mika, "my card", { files: [png] });
  expect(blocked.status).toBe(422);
  expect(await blocked.json()).toMatchObject({ code: "dlp-blocked", files: ["card.png"] });
  expect(seen[0].messages[1].content[0].image_url.url.startsWith("data:image/png;base64,")).toBe(true);

  reads("Invoice\nCard: 4111-1111-1111-1111");
  const pdf = await upload(mika, await scannedPdf(), "application/pdf", "scan.pdf");
  const stopped = await post(mika, "the invoice", { files: [pdf] });
  expect(stopped.status).toBe(422);
  expect(await stopped.json()).toMatchObject({ files: ["scan.pdf"] });
  expect(seen[1].messages[1].content[0].image_url.url.startsWith("data:image/jpeg;base64,/9j/")).toBe(true);

  // Neither the picture nor what it said is kept or logged.
  const audits = await env.DB.prepare("SELECT * FROM audit_events WHERE org_id = ?1").bind(ORG).all();
  // The number as it was written, not "4111": four digits turn up by chance
  // in the rows' random hashes and ciphertext.
  const logged = JSON.stringify(audits.results);
  for (const written of ["4111 1111 1111 1111", "4111-1111-1111-1111", "4111111111111111", "KEN SATO", "Invoice"]) {
    expect(logged).not.toContain(written);
  }
  const billed = await env.DB.prepare("SELECT purpose, user_github_id FROM ai_calls WHERE org_id = ?1").bind(ORG).all();
  expect(billed.results).toEqual([{ purpose: "dlp_ocr", user_github_id: "9202" }, { purpose: "dlp_ocr", user_github_id: "9202" }]);

  // A picture with nothing to hide goes; so does one the model could not read.
  reads("Lunch menu\nCurry 900");
  const menu = await upload(mika, PNG, "image/png", "menu.png");
  expect((await post(mika, "lunch?", { files: [menu] })).status).toBe(201);
  reads("", 500);
  const blurry = await upload(mika, PNG, "image/png", "blurry.png");
  expect((await post(mika, "hmm", { files: [blurry] })).status).toBe(201);
});

test("with no rules on, or with the workspace's model not able to see, nothing is sent", async () => {
  await call("/orgs/dlp/settings", toru, { method: "PUT", body: { orgId: ORG, readPictures: true } });
  const rules = await (await call(`/orgs/dlp?orgId=${encodeURIComponent(ORG)}`, toru)).json();
  await call(`/orgs/dlp/${rules.rules[0].id}`, toru, { method: "PATCH", body: { orgId: ORG, enabled: false } });
  const png = await upload(mika, PNG, "image/png", "card.png");
  expect((await post(mika, "my card", { files: [png] })).status).toBe(201);
  expect(seen).toHaveLength(0);

  // A model that does not see pictures: said so, and never sent one.
  const other = await worker.fetch(new Request(`https://example.com/orgs/dlp?orgId=${encodeURIComponent(ORG)}`, { headers: { "x-session-token": toru } }),
    { ...env, OPENAI_API_KEY: undefined, OPENROUTER_API_KEY: "or-test" }, ctx);
  expect((await other.json()).pictures).toEqual({ on: true, available: false });
});
