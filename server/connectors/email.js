import { simpleParser } from "mailparser";
import crypto from "crypto";

/**
 * Parse a raw RFC822 email (as delivered by a Mailgun webhook) into the
 * fields the rest of the connector needs.
 * @param {string|Buffer} rawMessage
 * @returns {Promise<Object>}
 */
async function parseEmailMessage(rawMessage) {
  const parsed = await simpleParser(rawMessage);

  return {
    messageId: parsed.messageId || `no-id-${Date.now()}`,
    from: parsed.from?.text || "unknown@example.com",
    fromName:
      parsed.from?.value?.[0]?.name || parsed.from?.text?.split("<")[0].trim() || "Unknown",
    to: parsed.to?.text || "",
    subject: parsed.subject || "(no subject)",
    textBody: parsed.text || "",
    htmlBody: parsed.html || "",
    timestamp: parsed.date || new Date(),
    hash: hashOf(parsed.messageId, parsed.from?.text),
  };
}

/** Stable id for deduplication — same message twice hashes the same. */
function hashOf(messageId, from) {
  return crypto.createHash("md5").update(`${messageId}:${from}`).digest("hex");
}

// Mailgun's own guidance: reject signatures older than this to bound replay
// window. https://documentation.mailgun.com/en/latest/user_manual.html#webhooks
const MAX_TIMESTAMP_SKEW_SECONDS = 15 * 60;

// Tokens are meant to be single-use (Mailgun issues a fresh one per event).
// Without this, a captured valid request could be resent verbatim forever —
// the signature only covers timestamp+token, never the email body, so a
// replayed request could even carry a *different* body than the original.
// In-memory only: acceptable for the legacy relay's single-process, no
// durability requirements; entries expire on their own via the prune below.
const consumedTokens = new Map(); // token -> expiry (ms epoch)

function pruneConsumedTokens(nowMs) {
  for (const [token, expiresAt] of consumedTokens) {
    if (expiresAt <= nowMs) consumedTokens.delete(token);
  }
}

/**
 * Validate a Mailgun webhook signature.
 *
 * Fails closed by default: a request with no signature fields at all, or a
 * missing signing key, is rejected. Local/manual test traffic (curl, the
 * integration tests) must opt in explicitly via
 * `ALLOW_UNSIGNED_EMAIL_WEBHOOK=1` — this flag must never be set in
 * production.
 */
function validateMailgunSignature(timestamp, token, signature) {
  const hasAnySignatureField = Boolean(timestamp || token || signature);

  if (!hasAnySignatureField) {
    return process.env.ALLOW_UNSIGNED_EMAIL_WEBHOOK === "1";
  }

  // A partial signature (some fields present, not all) is never valid —
  // don't try to make sense of it.
  if (!timestamp || !token || !signature) {
    return false;
  }

  if (!process.env.MAILGUN_WEBHOOK_SIGNING_KEY) {
    console.error("MAILGUN_WEBHOOK_SIGNING_KEY not set; rejecting signed email webhook request");
    return false;
  }

  const nowMs = Date.now();
  const timestampMs = Number(timestamp) * 1000;
  if (!Number.isFinite(timestampMs) || Math.abs(nowMs - timestampMs) > MAX_TIMESTAMP_SKEW_SECONDS * 1000) {
    return false;
  }

  const expected = Buffer.from(
    crypto.createHmac("sha256", process.env.MAILGUN_WEBHOOK_SIGNING_KEY).update(`${timestamp}${token}`).digest("hex"),
    "hex"
  );
  // Buffer.from(signature, "hex") silently stops at the first non-hex
  // character rather than throwing, so a garbage signature just produces a
  // buffer of a different length — caught by the length check before
  // timingSafeEqual (which throws on mismatched lengths).
  const actual = Buffer.from(String(signature), "hex");
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
    return false;
  }

  pruneConsumedTokens(nowMs);
  if (consumedTokens.has(token)) {
    return false;
  }
  consumedTokens.set(token, nowMs + MAX_TIMESTAMP_SKEW_SECONDS * 1000);

  return true;
}

export { parseEmailMessage, validateMailgunSignature };
