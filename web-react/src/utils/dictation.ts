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

/// Start listening. `onText` gets the whole utterance so far, interim words
/// included, so the box fills as the person speaks; `onEnd` fires when the
/// browser stops on its own or `stop` is called.
export function startDictation(lang: string, onText: (text: string, final: boolean) => void, onEnd: (error?: string) => void): Dictation | null {
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
    onText(finalText + interim, !interim)
  }
  r.onerror = (e) => onEnd(e.error || 'error')
  r.onend = () => onEnd()
  try { r.start() } catch { return null }
  return { stop: () => { try { r.stop() } catch { /* already stopped */ } } }
}
