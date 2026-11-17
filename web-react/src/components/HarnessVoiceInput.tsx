import React, { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from './Icon'
import { useT } from '../utils/i18n'
import { getLocale } from '../utils/locale'
import { detectDictationRangeCorrection, dictationAvailable, readDictationCorrections, readDictationVocabulary, startDictation, writeDictationCorrections, writeDictationVocabulary, type Dictation } from '../utils/dictation'

type TextControl = HTMLInputElement | HTMLTextAreaElement
type Dictionary = { vocabulary: string[]; corrections: Array<{ from: string; to: string }>; revision: number }
type DictationApi = { dictationVocabulary: () => Promise<Dictionary>; saveDictationVocabulary: (vocabulary: string[], corrections: Array<{ from: string; to: string }>, expectedRevision: number) => Promise<Dictionary> }

export function voiceInputEligible(field: { tagName: string; type?: string; disabled?: boolean; readOnly?: boolean; hidden?: boolean; inlineMic?: boolean }) {
  if (field.disabled || field.readOnly || field.hidden || field.inlineMic) return false
  return field.tagName.toLowerCase() === 'textarea' || field.tagName.toLowerCase() === 'input' && ['text', 'search', 'email', 'url', 'tel'].includes(String(field.type || 'text').toLowerCase())
}

export function dictatedValue(value: string, start: number, end: number, spoken: string, maxLength = -1) {
  let prefix = value.slice(0, start)
  const suffix = value.slice(end)
  if (end === value.length && prefix && !/\s$/u.test(prefix)) prefix += ' '
  const available = Math.max(0, (maxLength > 0 ? maxLength : Infinity) - prefix.length - suffix.length)
  const text = spoken.slice(0, available)
  return { value: prefix + text + suffix, caret: prefix.length + text.length, truncated: spoken.length > available }
}

function textControl(value: EventTarget | null): value is TextControl {
  if (!(value instanceof HTMLInputElement || value instanceof HTMLTextAreaElement)) return false
  if (value.disabled || value.readOnly || value.hidden || value.getClientRects().length === 0 || value.getAttribute('aria-hidden') === 'true' || value.closest('[inert], [aria-hidden="true"], [data-voice-input="off"]')) return false
  if (!voiceInputEligible({ tagName: value.tagName, type: value instanceof HTMLInputElement ? value.type : undefined, disabled: value.disabled, readOnly: value.readOnly, hidden: value.hidden || value.getAttribute('aria-hidden') === 'true' })) return false
  // Chat composers and fields with their own mic already expose a more
  // contextual control. The floating mic fills the rest of the Harness UI.
  for (let parent: HTMLElement | null = value.parentElement, depth = 0; parent && depth < 5; parent = parent.parentElement, depth++) {
    if (parent.matches('.hx-dictation, .create-decision')) return false
    if (parent.querySelector('.hx-dictation, button.mic')) return false
  }
  return true
}

function setInputValue(target: TextControl, value: string, caret: number) {
  const prototype = target instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
  if (setter) setter.call(target, value)
  else target.value = value
  target.setSelectionRange(caret, caret)
  target.dispatchEvent(new Event('input', { bubbles: true }))
}

export function HarnessVoiceInput({ userId, api }: { userId: string; api: DictationApi }) {
  const t = useT()
  const [target, setTarget] = useState<TextControl | null>(null)
  const [listening, setListening] = useState(false)
  const [error, setError] = useState(false)
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null)
  const targetRef = useRef<TextControl | null>(null)
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const sessionRef = useRef<{ target: TextControl; handle: Dictation | null; active: boolean; prefix: string; suffix: string; lastValue: string } | null>(null)
  const learningRef = useRef<{ target: TextControl; expected: string; prefix: string; suffix: string; at: number } | null>(null)
  const savingCorrectionRef = useRef(false)
  const dictionaryRef = useRef<Dictionary>({ vocabulary: readDictationVocabulary(userId), corrections: readDictationCorrections(userId), revision: 0 })
  const canDictate = dictationAvailable()

  const saveLearnedCorrection = useCallback((correction: { from: string; to: string }) => {
    const current = dictionaryRef.current
    if (savingCorrectionRef.current || current.corrections.some(item => item.from.toLocaleLowerCase() === correction.from.toLocaleLowerCase())) return
    savingCorrectionRef.current = true
    const add = (base: Dictionary) => ({ ...base, corrections: writeDictationCorrections(userId, [...base.corrections, correction]) })
    const pending = add(current)
    dictionaryRef.current = pending
    void (async () => {
      try {
        const saved = await api.saveDictationVocabulary(pending.vocabulary, pending.corrections, current.revision)
        dictionaryRef.current = { ...saved, vocabulary: writeDictationVocabulary(userId, saved.vocabulary), corrections: writeDictationCorrections(userId, saved.corrections) }
      } catch {
        // Another device may have updated the dictionary. Refresh once, then
        // retry with its revision so a correction never overwrites newer data.
        try {
          const latest = await api.dictationVocabulary()
          if (latest.corrections.some(item => item.from.toLocaleLowerCase() === correction.from.toLocaleLowerCase())) {
            dictionaryRef.current = { ...latest, vocabulary: writeDictationVocabulary(userId, latest.vocabulary), corrections: writeDictationCorrections(userId, latest.corrections) }
          } else {
            const retry = add(latest)
            const saved = await api.saveDictationVocabulary(retry.vocabulary, retry.corrections, latest.revision)
            dictionaryRef.current = { ...saved, vocabulary: writeDictationVocabulary(userId, saved.vocabulary), corrections: writeDictationCorrections(userId, saved.corrections) }
          }
        } catch { /* The account-local correction still applies on this device. */ }
      } finally { savingCorrectionRef.current = false }
    })()
  }, [api, userId])

  const stop = useCallback(() => {
    const session = sessionRef.current
    sessionRef.current = null
    if (session) {
      session.active = false
      session.handle?.stop()
    }
    setListening(false)
  }, [])

  const place = useCallback((field: TextControl | null) => {
    if (!field?.isConnected) { setPosition(null); return }
    const rect = field.getBoundingClientRect()
    const width = 32
    const left = Math.max(8, Math.min(window.innerWidth - width - 8, rect.right - width - 3))
    const top = Math.max(4, Math.min(window.innerHeight - width - 4, rect.top + Math.max(0, (rect.height - width) / 2)))
    setPosition({ top, left })
  }, [])

  useEffect(() => {
    dictionaryRef.current = { vocabulary: readDictationVocabulary(userId), corrections: readDictationCorrections(userId), revision: 0 }
    let cancelled = false
    void api.dictationVocabulary().then(remote => {
      if (cancelled) return
      dictionaryRef.current = { ...remote, vocabulary: writeDictationVocabulary(userId, remote.vocabulary), corrections: writeDictationCorrections(userId, remote.corrections) }
    }).catch(() => { /* Use the account-scoped local copy when offline. */ })
    const changed = (event: Event) => {
      const detail = (event as CustomEvent<{ userId?: string; revision?: number }>).detail
      if (detail?.userId !== userId || !Number.isSafeInteger(detail.revision) || Number(detail.revision) <= dictionaryRef.current.revision) return
      void api.dictationVocabulary().then(remote => {
        if (!cancelled && remote.revision >= dictionaryRef.current.revision) dictionaryRef.current = { ...remote, vocabulary: writeDictationVocabulary(userId, remote.vocabulary), corrections: writeDictationCorrections(userId, remote.corrections) }
      }).catch(() => { /* Keep the last account-local copy when offline. */ })
    }
    window.addEventListener('honmaru:dictation-vocabulary-changed', changed)
    return () => { cancelled = true; window.removeEventListener('honmaru:dictation-vocabulary-changed', changed); stop() }
  }, [api, userId, stop])

  useEffect(() => {
    if (!canDictate) return
    const activate = (candidate: EventTarget | null) => {
      const next = candidate === buttonRef.current ? targetRef.current : textControl(candidate) ? candidate : null
      if (next === targetRef.current) { place(next); return }
      stop()
      targetRef.current = next
      setTarget(next)
      setError(false)
      place(next)
    }
    const focus = (event: FocusEvent) => activate(event.target)
    const input = (event: Event) => {
      const pending = learningRef.current
      if (!pending || event.target !== pending.target) return
      const field = pending.target
      if (Date.now() - pending.at > 5 * 60_000 || !field.isConnected) { learningRef.current = null; return }
      if (field.value === pending.expected) return
      if (!field.value.startsWith(pending.prefix) || pending.suffix && !field.value.endsWith(pending.suffix)) { learningRef.current = null; return }
      const correction = detectDictationRangeCorrection(pending.expected, field.value, pending.prefix, pending.suffix, getLocale())
      if (correction) { learningRef.current = null; saveLearnedCorrection(correction) }
    }
    const blur = () => queueMicrotask(() => {
      if (document.activeElement === targetRef.current || document.activeElement === buttonRef.current) return
      stop()
      targetRef.current = null
      setTarget(null)
      setPosition(null)
    })
    const reposition = () => place(targetRef.current)
    document.addEventListener('focusin', focus)
    document.addEventListener('focusout', blur)
    document.addEventListener('input', input)
    window.addEventListener('resize', reposition)
    window.addEventListener('scroll', reposition, true)
    // The Harness shell can mount after route navigation has already focused
    // the search field. Pick up that initial focus as well as later focusin.
    if (textControl(document.activeElement)) activate(document.activeElement)
    return () => {
      document.removeEventListener('focusin', focus)
      document.removeEventListener('focusout', blur)
      document.removeEventListener('input', input)
      window.removeEventListener('resize', reposition)
      window.removeEventListener('scroll', reposition, true)
    }
  }, [canDictate, place, saveLearnedCorrection, stop])

  const toggle = useCallback(() => {
    if (sessionRef.current) { stop(); return }
    const field = targetRef.current
    if (!field?.isConnected || field.disabled || field.readOnly) return
    const start = field.selectionStart ?? field.value.length
    const end = field.selectionEnd ?? field.value.length
    let prefix = field.value.slice(0, start)
    const suffix = field.value.slice(end)
    if (end === field.value.length && prefix && !/\s$/u.test(prefix)) prefix += ' '
    const session = { target: field, handle: null as Dictation | null, active: true, prefix, suffix, lastValue: field.value }
    sessionRef.current = session
    setError(false)
    setListening(true)
    const dictionary = dictionaryRef.current
    const handle = startDictation(getLocale() === 'ja' ? 'ja-JP' : getLocale(), spoken => {
      if (!session.active || sessionRef.current !== session || !field.isConnected || document.activeElement !== field && document.activeElement !== buttonRef.current) { stop(); return }
      // Keep the range captured before listening so successive interim
      // transcripts replace one another instead of duplicating words.
      const fixed = dictatedValue(session.lastValue, session.prefix.length, session.lastValue.length - session.suffix.length, spoken, field.maxLength)
      const value = fixed.value
      learningRef.current = { target: field, expected: value, prefix: session.prefix, suffix: session.suffix, at: Date.now() }
      setInputValue(field, value, fixed.caret)
      session.lastValue = value
      if (fixed.truncated) stop()
    }, reason => {
      if (sessionRef.current !== session || !session.active) return
      session.active = false
      sessionRef.current = null
      setListening(false)
      if (reason && reason !== 'aborted' && reason !== 'no-speech') setError(true)
    }, dictionary.vocabulary, dictionary.corrections)
    session.handle = handle
    if (!handle) { session.active = false; sessionRef.current = null; setListening(false); setError(true) }
  }, [stop])

  if (!canDictate || !target || !position || typeof document === 'undefined') return null
  const portalRoot = target.closest('.harness-workspace') || document.body
  return createPortal(<>
    <button ref={buttonRef} className={`hx-global-dictation${listening ? ' is-listening' : ''}`} type="button" style={{ top: position.top, left: position.left }} aria-label={t(listening ? 'Stop voice input' : 'Voice input')} aria-pressed={listening} title={t(error ? 'Voice input unavailable. Check microphone access.' : listening ? 'Stop voice input' : 'Voice input')} onMouseDown={event => event.preventDefault()} onClick={toggle}>
      <Icon name={listening ? 'mic-off' : 'mic'} size={16}/>
    </button>
    {error && <span role="status" className="hx-global-dictation-status" style={{ top: position.top + 34, left: Math.max(8, Math.min(window.innerWidth - 248, position.left - 210)) }}>{t('Voice input unavailable. Check microphone access.')}</span>}
  </>, portalRoot)
}
