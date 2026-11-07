// Speech to text, with what the browser has. Chrome and Safari ship a
// recogniser; Firefox does not, and there the button simply is not offered.
// Nothing leaves this file but text.

type Recognizer = {
  lang: string
  continuous: boolean
  interimResults: boolean
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null
  onend: (() => void) | null
  onerror: ((e: { error?: string }) => void) | null
  start: () => void
  stop: () => void
}

function ctor(): (new () => Recognizer) | null {
  const w = window as unknown as { SpeechRecognition?: new () => Recognizer; webkitSpeechRecognition?: new () => Recognizer }
  return w.SpeechRecognition || w.webkitSpeechRecognition || null
}

export function dictationAvailable(): boolean {
  return typeof window !== 'undefined' && ctor() !== null
}

export interface Dictation { stop: () => void }

const DICTIONARY_PREFIX = 'honmaru.dictation.vocabulary.v2'
const CORRECTIONS_PREFIX = 'honmaru.dictation.corrections.v2'

/** Account vocabulary is cached locally; phrase correction happens in-app after
 * the browser returns recognized text, without sending dictionary hints. */
export function readDictationVocabulary(userId: string): string[] {
  if (!userId || typeof localStorage === 'undefined') return []
  try {
    const raw = JSON.parse(localStorage.getItem(`${DICTIONARY_PREFIX}:${encodeURIComponent(userId)}`) || '[]')
    if (!Array.isArray(raw)) return []
    return [...new Set(raw.filter((word): word is string => typeof word === 'string').map(word => word.trim()).filter(Boolean))].slice(0, 100)
  } catch { return [] }
}

export function writeDictationVocabulary(userId: string, words: string[]): string[] {
  const clean = [...new Set(words.map(word => word.trim()).filter(Boolean))].slice(0, 100)
  if (!userId || typeof localStorage === 'undefined') return clean
  try {
    const key = `${DICTIONARY_PREFIX}:${encodeURIComponent(userId)}`
    if (clean.length) localStorage.setItem(key, JSON.stringify(clean))
    else localStorage.removeItem(key)
  } catch { /* private browsing or storage quota: use for this render only */ }
  return clean
}

export type DictationCorrection = { from: string; to: string }

export function readDictationCorrections(userId: string): DictationCorrection[] {
  if (!userId || typeof localStorage === 'undefined') return []
  try {
    const raw = JSON.parse(localStorage.getItem(`${CORRECTIONS_PREFIX}:${encodeURIComponent(userId)}`) || '[]')
    if (!Array.isArray(raw)) return []
    return raw.filter((item): item is DictationCorrection => !!item && typeof item.from === 'string' && typeof item.to === 'string').slice(0, 100)
  } catch { return [] }
}

export function writeDictationCorrections(userId: string, corrections: DictationCorrection[]): DictationCorrection[] {
  const clean = corrections.filter(item => item.from.trim() && item.to.trim() && item.from !== item.to).slice(0, 100)
  if (!userId || typeof localStorage === 'undefined') return clean
  try {
    const key = `${CORRECTIONS_PREFIX}:${encodeURIComponent(userId)}`
    if (clean.length) localStorage.setItem(key, JSON.stringify(clean))
    else localStorage.removeItem(key)
  } catch { /* cache only; the API is authoritative */ }
  return clean
}

/** Apply private vocabulary locally after the browser returns transcript text. */
export function applyDictationVocabulary(text: string, vocabulary: string[], corrections: DictationCorrection[] = []): string {
  const corrected = [...corrections].sort((a, b) => b.from.length - a.from.length).reduce((result, item) => {
    const escaped = item.from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const bounded = /^[\p{L}\p{N}][\p{L}\p{N}._'’+-]*$/u.test(item.from)
    const pattern = bounded ? new RegExp(`(^|[^\\p{L}\\p{N}_])${escaped}(?=$|[^\\p{L}\\p{N}_])`, 'giu') : new RegExp(escaped, 'giu')
    return bounded ? result.replace(pattern, (_match, before='') => `${before}${item.to}`) : result.replace(pattern, item.to)
  }, text)
  return [...vocabulary].sort((a, b) => b.length - a.length).reduce((result, word) => {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const bounded = /^[\p{L}\p{N}][\p{L}\p{N}._'’+-]*$/u.test(word)
    const pattern = bounded ? new RegExp(`(^|[^\\p{L}\\p{N}_])${escaped}(?=$|[^\\p{L}\\p{N}_])`, 'giu') : new RegExp(escaped, 'giu')
    return bounded ? result.replace(pattern, (_match, before='') => `${before}${word}`) : result.replace(pattern, word)
  }, corrected)
}

/** Infer one user correction in a dictated suffix, never from arbitrary prose. */
export function detectDictationCorrection(previous: string, edited: string, dictatedPrefix: string, locale = 'en'): DictationCorrection | null {
  if (!previous.startsWith(dictatedPrefix) || !edited.startsWith(dictatedPrefix)) return null
  const before = previous.slice(dictatedPrefix.length), after = edited.slice(dictatedPrefix.length)
  if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(before + after)) {
    if (typeof Intl.Segmenter !== 'function') return null
    const segmenter = new Intl.Segmenter(locale, { granularity: 'word' })
    const words = (text: string) => [...segmenter.segment(text)].filter(part => part.isWordLike).map(part => part.segment)
    const oldWords = words(before), newWords = words(after)
    let head = 0
    while (head < oldWords.length && head < newWords.length && oldWords[head] === newWords[head]) head++
    let tail = 0
    while (tail < oldWords.length - head && tail < newWords.length - head && oldWords[oldWords.length - tail - 1] === newWords[newWords.length - tail - 1]) tail++
    const oldChanges = oldWords.slice(head, oldWords.length - tail), newChanges = newWords.slice(head, newWords.length - tail)
    return oldChanges.length === 1 && newChanges.length === 1 && oldChanges[0] !== newChanges[0]
      ? { from: oldChanges[0], to: newChanges[0] }
      : null
  }
  let prefix = 0
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++
  let suffix = 0
  while (suffix < before.length - prefix && suffix < after.length - prefix && before[before.length - suffix - 1] === after[after.length - suffix - 1]) suffix++
  let start = prefix, beforeEnd = before.length - suffix, afterEnd = after.length - suffix
  const wordChar = (value: string) => /^[\p{L}\p{N}._'’+-]$/u.test(value)
  while (start > 0 && wordChar(before[start - 1]) && wordChar(after[start - 1])) start--
  while (beforeEnd < before.length && afterEnd < after.length && wordChar(before[beforeEnd]) && wordChar(after[afterEnd])) { beforeEnd++; afterEnd++ }
  const from = before.slice(start, beforeEnd)
  const to = after.slice(start, afterEnd)
  const token = /^[\p{L}\p{N}][\p{L}\p{N}._'’+-]{1,79}$/u
  if (!token.test(from) || !token.test(to) || from === to) return null
  return { from, to }
}

/// Start listening. `onText` gets the whole utterance so far, interim words
/// included, so the box fills as the person speaks; `onEnd` fires when the
/// browser stops on its own or `stop` is called.
export function startDictation(lang: string, onText: (text: string, final: boolean) => void, onEnd: (error?: string) => void, vocabulary: string[] = [], corrections: DictationCorrection[] = []): Dictation | null {
  const Ctor = ctor()
  if (!Ctor) return null
  const r = new Ctor()
  r.lang = lang
  r.continuous = true
  r.interimResults = true
  let finalText = ''
  r.onresult = (e) => {
    let interim = ''
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const res = e.results[i]
      if (res.isFinal) finalText += res[0].transcript
      else interim += res[0].transcript
    }
    onText(applyDictationVocabulary(finalText + interim, vocabulary, corrections), !interim)
  }
  r.onerror = (e) => onEnd(e.error || 'error')
  r.onend = () => onEnd()
  try { r.start() } catch { return null }
  return { stop: () => { try { r.stop() } catch { /* already stopped */ } } }
}
