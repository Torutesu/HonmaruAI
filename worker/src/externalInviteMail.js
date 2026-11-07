import { sendMail, isMailConfigured } from "./mailer.js";

// Email is a convenience channel; the invitation record and copyable link are
// the source of truth. A provider refusal must never revoke a valid invitation.
export async function deliverExternalInvite(env, { id, to, resource, inviteUrl, expiresAt }) {
  if (!isMailConfigured(env)) return { status: "not_configured" };
  const safeResource = String(resource || "a shared resource").replace(/[\r\n\x00-\x1f\x7f]/g, " ").slice(0, 180);
  const subject = `You were invited to view ${safeResource} on Honmaru AI`;
  const text = [
    `You were invited to access ${safeResource} on Honmaru AI.`,
    "",
    "Sign in with the invited email address to accept this invitation:",
    inviteUrl,
    "",
    `Invitation expires: ${expiresAt}`,
    "Access is limited to the shared resource and can be revoked by its owner.",
  ].join("\n");
  const result = await sendMail(env, {
    to,
    subject,
    text,
    // A retried create request must not send duplicate invitations.
    idempotencyKey: `external-invite-${id}`,
  });
  return { status: result.ok ? "sent" : "failed" };
}
