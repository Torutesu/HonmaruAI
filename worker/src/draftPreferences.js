// Personal style learned only when a person explicitly asks Honmaru to
// remember an edit to an AI-generated reply. Store bounded style signals,
// never the draft itself: email and Slack drafts can contain confidential data.
const MAX = 8;

function lineCount(text) {
  return String(text || '').split(/\n\s*\n/).filter((line) => line.trim()).length;
}

function hasBullets(text) {
  return /^\s*(?:[-*•]|\d+[.)])\s+/m.test(String(text || ''));
}

function hasGreeting(text) {
  return /^(?:hi\b|hello\b|dear\b|お疲れ様です|こんにちは|いつもお世話になっております)/i.test(String(text || '').trim());
}

function hasSignoff(text) {
  return /(?:best(?: regards)?|kind regards|regards|thanks|thank you|よろしくお願いいたします|よろしくお願いします|以上です)[,.！。\s]*$/i.test(String(text || '').trim());
}

/// Returns a small allowlisted set of style observations, never user text.
export function inferDraftStyle(original, revised) {
  if (typeof original !== 'string' || typeof revised !== 'string') return [];
  const before = original.trim();
  const after = revised.trim();
  if (!before || !after || before === after) return [];
  const out = [];
  const ratio = after.length / Math.max(1, before.length);
  if (ratio <= 0.78) out.push({ key: 'concise', text: 'Prefer concise replies; remove unnecessary wording.' });
  else if (ratio >= 1.28) out.push({ key: 'detailed', text: 'Prefer a little more context and detail in replies.' });
  if (hasBullets(after) && !hasBullets(before)) out.push({ key: 'bullets', text: 'Use short bullet lists when they make the reply easier to scan.' });
  if (!hasBullets(after) && hasBullets(before)) out.push({ key: 'prose', text: 'Prefer natural paragraphs over bullet lists.' });
  if (hasGreeting(after) && !hasGreeting(before)) out.push({ key: 'greeting', text: 'Include a brief, courteous greeting.' });
  if (!hasGreeting(after) && hasGreeting(before)) out.push({ key: 'no-greeting', text: 'Skip greetings and get to the point.' });
  if (hasSignoff(after) && !hasSignoff(before)) out.push({ key: 'signoff', text: 'End with a brief courteous sign-off.' });
  if (!hasSignoff(after) && hasSignoff(before)) out.push({ key: 'no-signoff', text: 'Do not add a sign-off unless requested.' });
  if (lineCount(after) > lineCount(before) + 1) out.push({ key: 'paragraphs', text: 'Use shorter paragraphs with more whitespace.' });
  return out.slice(0, MAX);
}

const cleanSource = (source) => /^[A-Za-z0-9_-]{1,40}$/.test(String(source || '')) ? String(source) : 'general';

export async function listDraftPreferences(db, { orgId, githubId, sourceApp = null }) {
  const scoped = sourceApp !== null;
  const { results = [] } = await db.prepare(`SELECT source_app, preference_key, preference_text, updated_at
    FROM hx_user_draft_style_preferences WHERE org_id=?1 AND user_github_id=?2${scoped ? ' AND source_app=?3' : ''}
    ORDER BY updated_at DESC LIMIT ?${scoped ? '4' : '3'}`).bind(orgId, String(githubId), ...(scoped ? [cleanSource(sourceApp), MAX] : [MAX])).all();
  return results.map((row) => ({ sourceApp: row.source_app, key: row.preference_key, text: row.preference_text, updatedAt: row.updated_at }));
}

export async function rememberDraftPreferences(db, { orgId, githubId, sourceApp, cardId, original, revised }) {
  const preferences = inferDraftStyle(original, revised);
  if (!preferences.length) return { learned: [], unchanged: true };
  const source = cleanSource(sourceApp);
  const now = new Date().toISOString();
  await db.batch(preferences.map(({ key, text }) => db.prepare(`INSERT INTO hx_user_draft_style_preferences
    (org_id,user_github_id,source_app,preference_key,preference_text,source_card_id,updated_at)
    SELECT ?1,?2,?3,?4,?5,?6,?7 WHERE EXISTS (
      SELECT 1 FROM memberships WHERE org_id=?1 AND user_github_id=?2)
    ON CONFLICT(org_id,user_github_id,source_app,preference_key) DO UPDATE SET
      preference_text=excluded.preference_text,source_card_id=excluded.source_card_id,updated_at=excluded.updated_at`)
    .bind(orgId, String(githubId), source, key, text, String(cardId).slice(0, 160), now)));
  return { learned: preferences.map(({ key, text }) => ({ key, text, updatedAt: now })), unchanged: false };
}

export async function forgetDraftPreferences(db, { orgId, githubId, sourceApp, key }) {
  const source = sourceApp ? cleanSource(sourceApp) : null;
  const prefKey = typeof key === 'string' && /^[a-z-]{1,32}$/.test(key) ? key : null;
  const result = await db.prepare(`DELETE FROM hx_user_draft_style_preferences
    WHERE org_id=?1 AND user_github_id=?2${source ? ' AND source_app=?3' : ''}${prefKey ? ` AND preference_key=?${source ? '4' : '3'}` : ''}`)
    .bind(orgId, String(githubId), ...(source ? [source] : []), ...(prefKey ? [prefKey] : [])).run();
  return result?.meta?.changes || 0;
}
