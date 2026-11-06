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

export function normalizeCorrections(value) {
  if (!Array.isArray(value) || value.length > MAX_WORDS) return null;
  const corrections = [];
  const seen = new Set();
  for (const item of value) {
    if (!item || typeof item.from !== 'string' || typeof item.to !== 'string' || item.from.length > MAX_WORD_LENGTH || item.to.length > MAX_WORD_LENGTH) return null;
    const from = item.from.trim(), to = item.to.trim();
    if (!from || !to || from === to) continue;
    const key = from.toLocaleLowerCase();
    if (!seen.has(key)) { seen.add(key); corrections.push({ from, to }); }
  }
  return corrections;
}

export async function readDictationVocabulary(db, userId) {
  const row = await db.prepare(`SELECT vocabulary,corrections,revision FROM hx_user_dictation_accounts
    WHERE user_id=?1`).bind(String(userId)).first();
  let words = [];
  try { words = normalizeVocabulary(JSON.parse(row?.vocabulary || '[]')) || []; } catch { words = []; }
  let corrections = [];
  try { corrections = normalizeCorrections(JSON.parse(row?.corrections || '[]')) || []; } catch { corrections = []; }
  return { vocabulary: words, corrections, revision: Number(row?.revision || 0) };
}

export async function saveDictationVocabulary(db, userId, value, correctionValue = [], expectedRevision, now = new Date().toISOString()) {
  const vocabulary = normalizeVocabulary(value);
  if (!vocabulary) return { error: 'Vocabulary must contain at most 100 phrases of 80 characters each.', status: 400 };
  const corrections = normalizeCorrections(correctionValue);
  if (!corrections) return { error: 'Corrections must contain at most 100 pairs of 80 characters each.', status: 400 };
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) return { error: 'expectedRevision must be a non-negative integer.', status: 400 };
  const row = await db.prepare(`INSERT INTO hx_user_dictation_accounts
      (user_id,vocabulary,corrections,revision,updated_at)
    SELECT ?1,?2,?3,1,?4 WHERE ?5=0
    ON CONFLICT(user_id) DO UPDATE SET
      vocabulary=excluded.vocabulary,
      corrections=excluded.corrections,
      revision=hx_user_dictation_accounts.revision+1,
      updated_at=excluded.updated_at
    WHERE hx_user_dictation_accounts.revision=?5
    RETURNING vocabulary,corrections,revision`)
    .bind(String(userId), JSON.stringify(vocabulary), JSON.stringify(corrections), now, expectedRevision).first();
  if (!row) return { error: 'The voice vocabulary changed on another device. Reload before saving.', status: 409 };
  return { vocabulary: JSON.parse(row.vocabulary), corrections: JSON.parse(row.corrections), revision: Number(row.revision) };
}
