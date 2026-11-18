const MAX_WORDS = 100;
const MAX_WORD_LENGTH = 80;
const DEFAULT_SHORTCUT = 'Alt+Shift+V';
const RESERVED_SHORTCUTS = new Set([
  'Meta+K','Ctrl+K','Meta+/','Ctrl+/','Meta+Shift+O','Ctrl+Shift+O','Meta+Enter','Ctrl+Enter','Meta+F','Ctrl+F','Meta+U','Ctrl+U',
  'Meta+Shift+A','Ctrl+Shift+A','Meta+Shift+D','Ctrl+Shift+D','Meta+A','Ctrl+A','Meta+C','Ctrl+C','Meta+V','Ctrl+V','Meta+X','Ctrl+X',
  'Meta+Z','Ctrl+Z','Meta+Y','Ctrl+Y','Meta+S','Ctrl+S','Meta+P','Ctrl+P','Meta+R','Ctrl+R','Meta+W','Ctrl+W','Meta+T','Ctrl+T',
  'Meta+N','Ctrl+N','Meta+L','Ctrl+L','Meta+Shift+V','Ctrl+Shift+V','Meta+Shift+I','Ctrl+Shift+I','Meta+Shift+J','Ctrl+Shift+J','Meta+Shift+C','Ctrl+Shift+C',
]);

export function normalizeVoiceShortcut(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length > 40) return false;
  const parts = value.split('+');
  const key = parts.at(-1) || '';
  const modifiers = ['Meta', 'Ctrl', 'Alt', 'Shift'];
  if (!/^[A-Z0-9]$/.test(key) || new Set(parts).size !== parts.length || parts.slice(0, -1).some(part => !modifiers.includes(part))) return false;
  if (parts.slice(0, -1).join('+') !== modifiers.filter(part => parts.includes(part)).join('+')) return false;
  if (!parts.slice(0, -1).some(part => ['Meta', 'Ctrl', 'Alt'].includes(part)) || RESERVED_SHORTCUTS.has(value)) return false;
  return value;
}

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
  const row = await db.prepare(`SELECT vocabulary,corrections,voice_shortcut,revision FROM hx_user_dictation_accounts
    WHERE user_id=?1`).bind(String(userId)).first();
  let words = [];
  try { words = normalizeVocabulary(JSON.parse(row?.vocabulary || '[]')) || []; } catch { words = []; }
  let corrections = [];
  try { corrections = normalizeCorrections(JSON.parse(row?.corrections || '[]')) || []; } catch { corrections = []; }
  const shortcut = normalizeVoiceShortcut(row?.voice_shortcut) || DEFAULT_SHORTCUT;
  return { vocabulary: words, corrections, shortcut, revision: Number(row?.revision || 0) };
}

export async function saveDictationVocabulary(db, userId, value, correctionValue = [], expectedRevision, shortcutValue, now = new Date().toISOString()) {
  const vocabulary = normalizeVocabulary(value);
  if (!vocabulary) return { error: 'Vocabulary must contain at most 100 phrases of 80 characters each.', status: 400 };
  const corrections = normalizeCorrections(correctionValue);
  if (!corrections) return { error: 'Corrections must contain at most 100 pairs of 80 characters each.', status: 400 };
  const shortcut = normalizeVoiceShortcut(shortcutValue);
  if (shortcut === false) return { error: 'Shortcut must be a supported, non-conflicting modified letter or number.', status: 400 };
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) return { error: 'expectedRevision must be a non-negative integer.', status: 400 };
  const row = await db.prepare(`INSERT INTO hx_user_dictation_accounts
      (user_id,vocabulary,corrections,voice_shortcut,revision,updated_at)
    SELECT ?1,?2,?3,COALESCE(?4,'Alt+Shift+V'),1,?5 WHERE ?6=0
    ON CONFLICT(user_id) DO UPDATE SET
      vocabulary=excluded.vocabulary,
      corrections=excluded.corrections,
      voice_shortcut=COALESCE(?4,hx_user_dictation_accounts.voice_shortcut),
      revision=hx_user_dictation_accounts.revision+1,
      updated_at=excluded.updated_at
    WHERE hx_user_dictation_accounts.revision=?6
    RETURNING vocabulary,corrections,voice_shortcut,revision`)
    .bind(String(userId), JSON.stringify(vocabulary), JSON.stringify(corrections), shortcut, now, expectedRevision).first();
  if (!row) return { error: 'The voice vocabulary changed on another device. Reload before saving.', status: 409 };
  return { vocabulary: JSON.parse(row.vocabulary), corrections: JSON.parse(row.corrections), shortcut: row.voice_shortcut || DEFAULT_SHORTCUT, revision: Number(row.revision) };
}
