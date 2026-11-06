const MAX_WORDS = 100;
const MAX_WORD_LENGTH = 80;

export function normalizeVocabulary(value) {
  if (!Array.isArray(value) || value.length > MAX_WORDS) return null;
  const words = [];
  const seen = new Set();
  for (const item of value) {
    if (typeof item !== 'string' || item.length > MAX_WORD_LENGTH) return null;
    const word = item.trim();
    if (!word) continue;
    const key = word.toLocaleLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      words.push(word);
    }
  }
  return words;
}

export async function readDictationVocabulary(db, orgId, userId) {
  const row = await db.prepare(`SELECT vocabulary,revision FROM hx_user_dictation_preferences
    WHERE org_id=?1 AND user_id=?2`).bind(orgId, String(userId)).first();
  let words = [];
  try { words = normalizeVocabulary(JSON.parse(row?.vocabulary || '[]')) || []; } catch { words = []; }
  return { vocabulary: words, revision: Number(row?.revision || 0) };
}

export async function saveDictationVocabulary(db, orgId, userId, value, expectedRevision, now = new Date().toISOString()) {
  const vocabulary = normalizeVocabulary(value);
  if (!vocabulary) return { error: 'Vocabulary must contain at most 100 phrases of 80 characters each.', status: 400 };
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) return { error: 'expectedRevision must be a non-negative integer.', status: 400 };
  const row = await db.prepare(`INSERT INTO hx_user_dictation_preferences
      (org_id,user_id,vocabulary,revision,updated_at)
    SELECT ?1,?2,?3,1,?4 WHERE ?5=0
    ON CONFLICT(org_id,user_id) DO UPDATE SET
      vocabulary=excluded.vocabulary,
      revision=hx_user_dictation_preferences.revision+1,
      updated_at=excluded.updated_at
    WHERE hx_user_dictation_preferences.revision=?5
    RETURNING vocabulary,revision`)
    .bind(orgId, String(userId), JSON.stringify(vocabulary), now, expectedRevision).first();
  if (!row) return { error: 'The voice vocabulary changed on another device. Reload before saving.', status: 409 };
  return { vocabulary: JSON.parse(row.vocabulary), revision: Number(row.revision) };
}
