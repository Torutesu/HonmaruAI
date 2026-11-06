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

const DICTIONARY_PREFIX = 'honmaru.dictation.vocabulary.v1'

/** User-scoped vocabulary lives on this device only; speech is still handled by
 * the browser and nothing in the dictionary is sent to a speech provider. */
export function readDictationVocabulary(orgId: string, userId: string): string[] {
  if (!orgId || !userId || typeof localStorage === 'undefined') return []
  try {
    const raw = JSON.parse(localStorage.getItem(`${DICTIONARY_PREFIX}:${encodeURIComponent(orgId)}:${encodeURIComponent(userId)}`) || '[]')
    if (!Array.isArray(raw)) return []
    return [...new Set(raw.filter((word): word is string => typeof word === 'string').map(word => word.trim()).filter(Boolean))].slice(0, 100)
  } catch { return [] }
}

export function writeDictationVocabulary(orgId: string, userId: string, words: string[]): string[] {
  const clean = [...new Set(words.map(word => word.trim()).filter(Boolean))].slice(0, 100)
  if (!orgId || !userId || typeof localStorage === 'undefined') return clean
  try {
    const key = `${DICTIONARY_PREFIX}:${encodeURIComponent(orgId)}:${encodeURIComponent(userId)}`
    if (clean.length) localStorage.setItem(key, JSON.stringify(clean))
    else localStorage.removeItem(key)
  } catch { /* private browsing or storage quota: use for this render only */ }
  return clean
}

/** Prefer a native phrase hint when supported, and also normalize returned text
 * for browsers which do not implement SpeechRecognition.phrases. */
export function applyDictationVocabulary(text: string, vocabulary: string[]): string {
  return [...vocabulary].sort((a, b) => b.length - a.length).reduce((result, word) => {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return result.replace(new RegExp(escaped, 'giu'), word)
  }, text)
}

/// Start listening. `onText` gets the whole utterance so far, interim words
/// included, so the box fills as the person speaks; `onEnd` fires when the
/// browser stops on its own or `stop` is called.
export function startDictation(lang: string, onText: (text: string, final: boolean) => void, onEnd: (error?: string) => void, vocabulary: string[] = []): Dictation | null {
  const Ctor = ctor()
  if (!Ctor) return null
  const r = new Ctor()
  r.lang = lang
  r.continuous = true
  r.interimResults = true
  const phraseRecognition = r as Recognizer & { phrases?: Array<{ phrase: string; boost?: number }> }
  if ('phrases' in phraseRecognition) {
    try { phraseRecognition.phrases = vocabulary.map(phrase => ({ phrase, boost: 5 })) } catch { /* browser hint is optional */ }
  }
  let finalText = ''
  r.onresult = (e) => {
    let interim = ''
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const res = e.results[i]
      if (res.isFinal) finalText += res[0].transcript
      else interim += res[0].transcript
    }
    onText(applyDictationVocabulary(finalText + interim, vocabulary), !interim)
  }
  r.onerror = (e) => onEnd(e.error || 'error')
  r.onend = () => onEnd()
  try { r.start() } catch { return null }
  return { stop: () => { try { r.stop() } catch { /* already stopped */ } } }
}
