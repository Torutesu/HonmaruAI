// Outbound mail, for the person who has nothing else.
//
// Not everyone installs the app, and not every browser is asked to allow
// notifications. Email is the channel every account already has, so it is the
// floor: when no push channel reaches someone, the decision goes there. It is
// also what carries a sign-in code, which is the only way in for someone who
// does not have GitHub.
//
// Resend, and only Resend. One API key, no domain, no DNS records, and a free
// tier that is a free tier rather than a trial — which matters for a channel
// that is a fallback and a sign-in code rather than the product. One HTTP
// call; there is nothing here worth a dependency.
//
// (The *inbound* side — mail arriving as decisions, connectors/email.js — is
// still Mailgun's webhook, which is a separate feature with a separate secret
// and no bearing on sending.)

// Resend's shared sender: no domain, no DNS, and delivery only to the address
// that owns the Resend account. A real limit, and the difference between
// working in two minutes and working after a DNS change.
const SHARED_SENDER = "onboarding@resend.dev";

export function isMailConfigured(env) {
  return Boolean(env.RESEND_API_KEY);
}

/// The From line. An explicit `NOTIFY_EMAIL_FROM` — which needs a domain
/// verified at Resend — always wins.
export function mailFrom(env) {
  return env.NOTIFY_EMAIL_FROM || `Honmaru AI <${SHARED_SENDER}>`;
}

/// Send one message. Returns `{ ok, status }` and never throws — the same rule
/// as every other channel: a notification that fails is a notification nobody
/// got, not a decision nobody made.
///
/// `detail` carries whatever Resend said about a refusal. Nothing reads it to
/// make a decision; it exists so that "no mail arrived" has an answer other
/// than a shrug. The usual causes — a wrong key, an unverified From domain, a
/// recipient the shared sender may not reach — are indistinguishable from
/// outside, and every one of them is a sentence in the response body.
export async function sendMail(env, { to, subject, text }) {
  if (!isMailConfigured(env)) return { ok: false, status: 0, skipped: "mail not configured" };
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.RESEND_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ from: mailFrom(env), to: [to], subject, text }),
    });
    if (res.ok) return { ok: true, status: res.status };
    const detail = (await res.text().catch(() => "")).slice(0, 300);
    console.error(`mail refused by Resend (${res.status}): ${detail}`);
    return { ok: false, status: res.status, detail };
  } catch (err) {
    console.error("mail send failed", err?.message || err);
    return { ok: false, status: 0 };
  }
}
