// Outbound mail, for the person who has nothing else.
//
// Not everyone installs the app, and not every browser is asked to allow
// notifications. Email is the channel every account already has, so it is the
// floor: when no push channel reaches someone, the decision goes there. It is
// also what carries a sign-in code, which is the only way in for someone who
// does not have GitHub.
//
// Two providers, because the choice is not really ours to make: whoever runs
// this deployment has to get credentials from somewhere, and "somewhere" keeps
// changing its free tier. Both are one HTTP call; neither is worth a
// dependency, and the caller cannot tell them apart.
//
//   RESEND_API_KEY                    → Resend. Nothing else needed to start.
//   MAILGUN_API_KEY + MAILGUN_DOMAIN  → Mailgun. Also what the inbound
//                                       webhook (connectors/email.js) uses.
//
// Resend is tried first when both exist, on the theory that someone who set it
// up more recently meant it.

const RESEND_TEST_SENDER = "onboarding@resend.dev";

/// Which provider this deployment can send with, or null.
export function mailProvider(env) {
  if (env.RESEND_API_KEY) return "resend";
  if (env.MAILGUN_API_KEY && env.MAILGUN_DOMAIN) return "mailgun";
  return null;
}

export function isMailConfigured(env) {
  return mailProvider(env) !== null;
}

/// The From line. An explicit `NOTIFY_EMAIL_FROM` always wins.
///
/// Resend's fallback is its shared sender, which needs no domain and no DNS —
/// and only delivers to the address that owns the Resend account. That is a
/// real limit, but it is the difference between "works in two minutes" and
/// "works after a DNS change", and the setup script says so out loud.
export function mailFrom(env) {
  if (env.NOTIFY_EMAIL_FROM) return env.NOTIFY_EMAIL_FROM;
  if (env.MAILGUN_DOMAIN) return `Honmaru AI <no-reply@${env.MAILGUN_DOMAIN}>`;
  return `Honmaru AI <${RESEND_TEST_SENDER}>`;
}

/// Send one message. Returns `{ ok, status }` and never throws — the same rule
/// as every other channel: a notification that fails is a notification nobody
/// got, not a decision nobody made.
///
/// `detail` carries whatever the provider said about a refusal. Nothing reads
/// it to make a decision; it exists so that "no mail arrived" has an answer
/// other than shrugging.
export async function sendMail(env, { to, subject, text }) {
  const provider = mailProvider(env);
  if (!provider) return { ok: false, status: 0, skipped: "mail not configured" };
  try {
    const res = provider === "resend"
      ? await sendViaResend(env, { to, subject, text })
      : await sendViaMailgun(env, { to, subject, text });
    if (res.ok) return { ok: true, status: res.status, provider };
    // Read the body only on a refusal, and only enough of it to be useful in a
    // log line. Providers explain themselves here — an unverified domain, an
    // unauthorized recipient — and that explanation is the whole difference
    // between a two-minute fix and an afternoon.
    const detail = (await res.text().catch(() => "")).slice(0, 300);
    console.error(`mail refused by ${provider} (${res.status}): ${detail}`);
    return { ok: false, status: res.status, provider, detail };
  } catch (err) {
    console.error("mail send failed", err?.message || err);
    return { ok: false, status: 0, provider };
  }
}

function sendViaResend(env, { to, subject, text }) {
  return fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ from: mailFrom(env), to: [to], subject, text }),
  });
}

function sendViaMailgun(env, { to, subject, text }) {
  const base = (env.MAILGUN_API_BASE || "https://api.mailgun.net").replace(/\/$/, "");
  const form = new URLSearchParams({ from: mailFrom(env), to, subject, text });
  return fetch(`${base}/v3/${env.MAILGUN_DOMAIN}/messages`, {
    method: "POST",
    headers: {
      authorization: `Basic ${btoa(`api:${env.MAILGUN_API_KEY}`)}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: form.toString(),
  });
}
