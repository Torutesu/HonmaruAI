const MAX_WORDS = 100;
const MAX_WORD_LENGTH = 80;
const DEFAULT_VOICE_SHORTCUT = 'Alt+Shift+V';
const RESERVED_VOICE_SHORTCUTS = new Set([
  'Meta+K','Ctrl+K','Meta+/','Ctrl+/','Meta+Shift+O','Ctrl+Shift+O','Meta+Enter','Ctrl+Enter',
  'Meta+F','Ctrl+F','Meta+W','Ctrl+W','Meta+T','Ctrl+T','Meta+R','Ctrl+R','Meta+L','Ctrl+L',
  'Meta+N','Ctrl+N','Meta+O','Ctrl+O','Meta+S','Ctrl+S','Meta+P','Ctrl+P','Meta+J','Ctrl+J',
  'Meta+H','Ctrl+H','Meta+D','Ctrl+D','Meta+Shift+V','Ctrl+Shift+V',
]);

export function normalizeVoiceShortcut(value) {
  if (typeof value !== 'string' || value.length > 64) return null;
  const parts = value.split('+');
  const key = parts.at(-1);
  const modifiers = parts.slice(0, -1);
  if (!/^[A-Z0-9]$/.test(key || '') || !modifiers.length
    || modifiers.some(item => !['Meta','Ctrl','Alt','Shift'].includes(item))
    || new Set(modifiers).size !== modifiers.length
    || !modifiers.some(item => ['Meta','Ctrl','Alt'].includes(item))) return null;
  const canonical = [...['Meta','Ctrl','Alt','Shift'].filter(item => modifiers.includes(item)), key].join('+');
  return canonical === value && !RESERVED_VOICE_SHORTCUTS.has(canonical) ? canonical : null;
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
  return { vocabulary: words, corrections, voiceShortcut: normalizeVoiceShortcut(row?.voice_shortcut) || DEFAULT_VOICE_SHORTCUT, revision: Number(row?.revision || 0) };
}

export async function saveDictationVocabulary(db, userId, value, correctionValue, expectedRevision, now = new Date().toISOString(), voiceShortcutValue) {
  const current = value === undefined || correctionValue === undefined ? await readDictationVocabulary(db, userId) : null;
  const vocabulary = normalizeVocabulary(value === undefined ? current.vocabulary : value);
  if (!vocabulary) return { error: 'Vocabulary must contain at most 100 phrases of 80 characters each.', status: 400 };
  const corrections = normalizeCorrections(correctionValue === undefined ? current.corrections : correctionValue);
  if (!corrections) return { error: 'Corrections must contain at most 100 pairs of 80 characters each.', status: 400 };
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) return { error: 'expectedRevision must be a non-negative integer.', status: 400 };
  const voiceShortcut = voiceShortcutValue === undefined ? null : normalizeVoiceShortcut(voiceShortcutValue);
  if (voiceShortcutValue !== undefined && !voiceShortcut) return { error: 'Choose a supported voice input shortcut.', status: 400 };
  const row = await db.prepare(`INSERT INTO hx_user_dictation_accounts
      (user_id,vocabulary,corrections,voice_shortcut,revision,updated_at)
    SELECT ?1,?2,?3,COALESCE(?6,'Alt+Shift+V'),1,?4 WHERE ?5=0
    ON CONFLICT(user_id) DO UPDATE SET
      vocabulary=excluded.vocabulary,
      corrections=excluded.corrections,
      voice_shortcut=COALESCE(?6,hx_user_dictation_accounts.voice_shortcut),
      revision=hx_user_dictation_accounts.revision+1,
      updated_at=excluded.updated_at
    WHERE hx_user_dictation_accounts.revision=?5
    RETURNING vocabulary,corrections,voice_shortcut,revision`)
    .bind(String(userId), JSON.stringify(vocabulary), JSON.stringify(corrections), now, expectedRevision, voiceShortcut).first();
  if (!row) return { error: 'The voice vocabulary changed on another device. Reload before saving.', status: 409 };
  return { vocabulary: JSON.parse(row.vocabulary), corrections: JSON.parse(row.corrections), voiceShortcut: normalizeVoiceShortcut(row.voice_shortcut) || DEFAULT_VOICE_SHORTCUT, revision: Number(row.revision) };
}
