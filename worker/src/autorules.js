// A standing yes. "Approve Mika's supplier requests in #cafe from now on"
// is a rule the recipient makes — offered after they have said yes to the
// same kind of request three times — and the relay applies it as a card
// arrives. The card still exists, decided, and says who decided it and why.

const APPROVABLE = new Set(["approval", "task", "revision"]);

export async function listAutoRules(db, orgId, login) {
  const { results } = await db.prepare(
    `SELECT r.*, u.name AS sender_name FROM auto_rules r LEFT JOIN users u ON u.login = r.sender_login
      WHERE r.org_id = ?1 AND r.recipient_login = ?2 ORDER BY r.created_at DESC`
  ).bind(orgId, login).all();
  return results || [];
}

export async function addAutoRule(db, { orgId, recipientLogin, senderLogin, cardType, business }) {
  if (!senderLogin || senderLogin === recipientLogin) return { error: "A rule is for requests from somebody else." };
  if (!APPROVABLE.has(cardType)) return { error: "Only requests that are approved can be approved automatically." };
  const count = await db.prepare("SELECT COUNT(*) AS n FROM auto_rules WHERE org_id = ?1 AND recipient_login = ?2").bind(orgId, recipientLogin).first();
  if ((count?.n || 0) >= 50) return { error: "You have as many rules as you can have. Remove one first." };
  const dup = await db.prepare(
    "SELECT id FROM auto_rules WHERE org_id = ?1 AND recipient_login = ?2 AND sender_login = ?3 AND card_type = ?4 AND COALESCE(business, '') = ?5"
  ).bind(orgId, recipientLogin, senderLogin, cardType, business || "").first();
  if (dup) return { id: dup.id };
  const id = crypto.randomUUID();
  await db.prepare(
    `INSERT INTO auto_rules (id, org_id, recipient_login, sender_login, card_type, business, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
  ).bind(id, orgId, recipientLogin, senderLogin, cardType, business || null, new Date().toISOString()).run();
  return { id };
}

export async function removeAutoRule(db, orgId, login, id) {
  const res = await db.prepare("DELETE FROM auto_rules WHERE id = ?1 AND org_id = ?2 AND recipient_login = ?3").bind(id, orgId, login).run();
  return (res.meta?.changes || 0) > 0;
}

/// Decide a new card by a rule, if one covers it. Mutates the card and
/// returns the rule; returns null and leaves the card alone otherwise.
export async function applyAutoRule(db, orgId, card) {
  if (!card || card.format === "fyi" || card.report || card.proposal || !APPROVABLE.has(card.type)) return null;
  if (!card.senderUserID || card.senderUserID === card.recipientUserID) return null;
  let rule;
  try {
    rule = await db.prepare(
      `SELECT * FROM auto_rules WHERE org_id = ?1 AND recipient_login = ?2 AND sender_login = ?3 AND card_type = ?4
          AND (business IS NULL OR business = ?5) LIMIT 1`
    ).bind(orgId, card.recipientUserID, card.senderUserID, card.type, card.business || "").first();
  } catch (err) {
    if (/no such table/i.test(String(err?.message))) return null;
    throw err;
  }
  if (!rule) return null;
  card.status = "approved";
  card.decision = {
    action: "approve",
    actorUserID: card.recipientUserID,
    decidedAt: new Date().toISOString(),
    note: "Approved automatically by a rule you set.",
  };
  card.autoApproved = { ruleId: rule.id };
  return rule;
}
