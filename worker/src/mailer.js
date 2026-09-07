// Outbound mail, for the person who has nothing else.
//
// Not everyone installs the app, and not every browser is asked to allow
// notifications. Email is the channel every account already has, so it is the
// floor: when no push channel reaches someone, the decision goes there.
//
// Mailgun, because the inbound side (connectors/email.js) already assumes it,
// and one vendor is one set of credentials to hand over. The API is a form
// post; there is nothing here worth a dependency.

export function isMailConfigured(env) {
  return Boolean(env.MAILGUN_API_KEY && env.MAILGUN_DOMAIN);
}

export function mailFrom(env) {
  return env.NOTIFY_EMAIL_FROM || `Honmaru AI <no-reply@${env.MAILGUN_DOMAIN}>`;
}

/// Send one message. Returns `{ ok, status }` and never throws — the same rule
/// as every other channel: a notification that fails is a notification nobody
/// got, not a decision nobody made.
export async function sendMail(env, { to, subject, text }) {
  if (!isMailConfigured(env)) return { ok: false, status: 0, skipped: "mail not configured" };
  try {
    const base = (env.MAILGUN_API_BASE || "https://api.mailgun.net").replace(/\/$/, "");
    const form = new URLSearchParams({ from: mailFrom(env), to, subject, text });
    const res = await fetch(`${base}/v3/${env.MAILGUN_DOMAIN}/messages`, {
      method: "POST",
      headers: {
        authorization: `Basic ${btoa(`api:${env.MAILGUN_API_KEY}`)}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
    });
    return { ok: res.ok, status: res.status };
  } catch (err) {
    console.error("mail send failed", err?.message || err);
    return { ok: false, status: 0 };
  }
}
