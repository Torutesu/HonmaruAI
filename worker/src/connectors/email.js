// Mail that arrives, rather than mail we go and fetch.
//
// Gmail, Slack and Notion are polled: the sync loop asks Composio what is new.
// Email is pushed — Mailgun posts a webhook the moment a message lands — so it
// is not in CONNECTORS and has no place in that loop. What it shares is
// everything after arrival: the same message shape, the same triage, the same
// card. Only the way the message reaches us is different.

// Mailgun's own guidance: refuse a signature older than this, so a captured
// request cannot be replayed forever.
const MAX_SKEW_SECONDS = 15 * 60;

/// Is this request really from Mailgun?
///
/// Fails closed. No signing key, no signature, a partial signature, a stale
/// timestamp or a token already spent all answer no. `ALLOW_UNSIGNED_EMAIL_WEBHOOK`
/// exists for local testing and must never be set in production — the reference
/// relay shipped with the unsigned case allowed by default, and that meant
/// anyone who knew the URL could put an approval card in someone's feed.
export async function verifyMailgunWebhook(env, { timestamp, token, signature }) {
  if (!timestamp && !token && !signature) {
    return env.ALLOW_UNSIGNED_EMAIL_WEBHOOK === "1";
  }
  // A partial signature is never valid; there is nothing to make sense of.
  if (!timestamp || !token || !signature) return false;
  if (!env.MAILGUN_WEBHOOK_SIGNING_KEY) {
    console.error("MAILGUN_WEBHOOK_SIGNING_KEY not set; refusing a signed email webhook");
    return false;
  }

  const skew = Math.abs(Date.now() - Number(timestamp) * 1000);
  if (!Number.isFinite(skew) || skew > MAX_SKEW_SECONDS * 1000) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.MAILGUN_WEBHOOK_SIGNING_KEY),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );
  const bytes = hexToBytes(String(signature));
  if (!bytes) return false;
  // subtle.verify compares in constant time, which is the reason to use it
  // rather than hashing ourselves and comparing strings.
  const ok = await crypto.subtle.verify(
    "HMAC", key, bytes, new TextEncoder().encode(`${timestamp}${token}`)
  );
  if (!ok) return false;

  // The signature covers timestamp and token — never the body — so a valid one
  // could otherwise be replayed with different mail attached. Spending the
  // token is what makes it single use.
  return await spendToken(env.DB, token);
}

function hexToBytes(hex) {
  if (hex.length % 2 || /[^0-9a-fA-F]/.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/// Record a nonce, or report that it has already been used.
///
/// The insert is the check: a primary key conflict means somebody — or
/// something replaying — got here first.
async function spendToken(db, token) {
  const expires = new Date(Date.now() + MAX_SKEW_SECONDS * 1000).toISOString();
  try {
    await db
      .prepare("INSERT INTO webhook_nonces (token, expires_at) VALUES (?1, ?2)")
      .bind(String(token), expires)
      .run();
    return true;
  } catch {
    return false;
  }
}

/// Mailgun's parsed fields, in the shape triage already understands.
///
/// The reference relay asked Mailgun for raw MIME and parsed it with
/// `mailparser`, which is a large Node dependency built on Node streams. Here
/// we take the fields Mailgun has already parsed. The Worker stays small, and
/// there is no MIME parser to be wrong about anything.
export function parseMailgunWebhook(fields) {
  const get = (...names) => {
    for (const n of names) {
      const v = fields.get ? fields.get(n) : fields[n];
      if (v) return String(v);
    }
    return "";
  };

  const messageId = get("Message-Id", "message-id", "Message-ID");
  const from = get("sender", "from", "From");
  if (!messageId && !from) return null;

  return {
    // Message-Id is what makes a redelivery the same message. Falling back to
    // sender+subject is weaker but still beats treating every retry as new.
    id: messageId || `${from}:${get("subject", "Subject")}`,
    from,
    subject: get("subject", "Subject") || "(no subject)",
    // stripped-text is the message without the quoted thread under it, which
    // is what triage should be reading.
    snippet: get("stripped-text", "body-plain", "body-html").slice(0, 4000),
    date: get("Date", "date") || new Date().toISOString(),
    recipient: get("recipient", "To", "to"),
  };
}

/// Which person this message is for.
///
/// The inbound address carries the answer: `u-<github id>@<your domain>`. The
/// reference relay routed every email to "the first user in the org's store",
/// which is insertion order — the same message could reach different people
/// depending on what the process happened to have seen. An address that names
/// its owner is the smallest thing that is actually correct.
export function githubIdFromAddress(recipient) {
  const local = String(recipient || "").split("@")[0];
  const match = local.match(/^u-(\d+)$/);
  return match ? match[1] : null;
}

export function inboundAddressFor(env, githubId) {
  const domain = env.INBOUND_EMAIL_DOMAIN;
  return domain ? `u-${githubId}@${domain}` : null;
}
