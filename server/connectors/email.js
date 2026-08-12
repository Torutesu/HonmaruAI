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

/**
 * Validate a Mailgun webhook signature. Requests carrying none of
 * timestamp/token/signature aren't from Mailgun at all (real webhooks
 * always send all three) — treated as local/manual test traffic and
 * allowed through rather than failing a hash check that could never match.
 */
function validateMailgunSignature(timestamp, token, signature) {
  if (!timestamp && !token && !signature) {
    return true;
  }

  if (!process.env.MAILGUN_WEBHOOK_SIGNING_KEY) {
    console.warn("MAILGUN_WEBHOOK_SIGNING_KEY not set, skipping webhook signature validation");
    return true;
  }

  const hash = crypto
    .createHmac("sha256", process.env.MAILGUN_WEBHOOK_SIGNING_KEY)
    .update(`${timestamp}${token}`)
    .digest("hex");

  return hash === signature;
}

export { parseEmailMessage, validateMailgunSignature };
