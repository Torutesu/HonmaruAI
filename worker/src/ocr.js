// The words in a picture, for the workspace's data rules (dlpFiles.js): a
// photo of a card, a screenshot of a spreadsheet, a PDF of scanned pages.
// Off unless an admin turns it on, because the picture then goes to the
// workspace's AI model to be read. It is read, checked against the rules,
// and dropped: neither the picture nor its words are kept or logged.
//
// It runs on the workspace's model (its own key when it has one) and counts
// against the same allowance as every other AI call. When the allowance is
// spent, the model is not OpenAI, or the model does not answer in time, the
// picture is simply not read, as before.

import { providerFor } from "./orgAI.js";
import { allowanceFor } from "./gate.js";
import { noteUsage, settleUsage } from "./ledger.js";
import { rulesOf } from "./dlp.js";

export const OCR_TYPES = /^image\/(png|jpeg|webp|gif)$/;
const MAX_PICTURE_BYTES = 4 * 1024 * 1024;
const MAX_CALLS_PER_MESSAGE = 4;

const PROMPT = `Transcribe every piece of text you can see in these images: printed, handwritten, in tables, on cards and screens. Keep numbers, codes and names exactly as written, digit for digit. Reading order, one line per line of text. Output only the text, nothing else; no commentary. If there is no text, output nothing.`;

/// Whether this workspace reads the words in pictures.
export async function readsPictures(db, orgId) {
  const row = await db.prepare("SELECT read_images FROM dlp_settings WHERE org_id = ?1").bind(orgId).first().catch(() => null);
  return Boolean(row?.read_images);
}

function base64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/// A reader for one message's pictures, or null when this workspace does not
/// read them (turned off, no rules to check, or no model that sees). Each
/// call takes one file's pictures and gives back their words, or "".
export async function pictureReader(env, { orgId, githubId }) {
  if (!(await readsPictures(env.DB, orgId))) return null;
  if (!(await rulesOf(env.DB, orgId, { enabledOnly: true })).length) return null;
  const provider = await providerFor(env, orgId).catch(() => null);
  if (!provider || provider.providerName !== "OpenAI") return null;
  let calls = 0;
  return async (pictures) => {
    const fit = pictures.filter((p) => OCR_TYPES.test(p.type) && p.bytes.length && p.bytes.length <= MAX_PICTURE_BYTES).slice(0, 4);
    if (!fit.length || calls >= MAX_CALLS_PER_MESSAGE) return "";
    const allowance = await allowanceFor(env, orgId, { githubId });
    if (!allowance.allowed) return "";
    calls++;
    try {
      const res = await (provider.request || fetch)(provider.endpoint, {
        signal: AbortSignal.timeout(25_000),
        method: "POST",
        headers: { Authorization: `Bearer ${provider.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: provider.model, temperature: 0, max_tokens: 3000,
          messages: [
            { role: "system", content: PROMPT },
            { role: "user", content: fit.map((p) => ({ type: "image_url", image_url: { url: `data:${p.type};base64,${base64(p.bytes)}`, detail: "high" } })) },
          ],
        }),
      });
      if (!res.ok) return "";
      const data = await res.json();
      noteUsage(provider, "dlp_ocr", data);
      if (allowance.metered) await allowance.consume();
      await settleUsage(env.DB, provider, { orgId, githubId });
      return String(data?.choices?.[0]?.message?.content || "").slice(0, 200_000);
    } catch {
      // Not in time, or not at all: this picture is not read.
      return "";
    }
  };
}
