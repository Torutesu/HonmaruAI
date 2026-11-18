import React, { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from './Icon'
import { useT } from '../utils/i18n'
import { getLocale } from '../utils/locale'
import { detectDictationRangeCorrection, dictationAvailable, readDictationCorrections, readDictationVocabulary, startDictation, writeDictationCorrections, writeDictationVocabulary, type Dictation } from '../utils/dictation'
import { matchesVoiceShortcut, readVoiceShortcut, writeVoiceShortcut } from '../utils/voiceShortcut'

type TextControl = HTMLInputElement | HTMLTextAreaElement
type VoiceTarget = TextControl | HTMLElement
type Dictionary = { vocabulary: string[]; corrections: Array<{ from: string; to: string }>; voiceShortcut: string; revision: number }
type DictationApi = { dictationVocabulary: () => Promise<Dictionary>; saveDictationVocabulary: (vocabulary: string[], corrections: Array<{ from: string; to: string }>, expectedRevision: number, voiceShortcut?: string) => Promise<Dictionary> }

export function voiceInputEligible(field: { tagName: string; type?: string; disabled?: boolean; readOnly?: boolean; hidden?: boolean; inlineMic?: boolean; contentEditable?: string }) {
  if (field.disabled || field.readOnly || field.hidden || field.inlineMic) return false
  if (field.contentEditable === 'true' || field.contentEditable === 'plaintext-only') return true
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

function hasInlineMic(value: HTMLElement) {
  for (let parent: HTMLElement | null = value.parentElement, depth = 0; parent && parent !== document.body && depth < 5; parent = parent.parentElement, depth++) {
    if (parent.matches('.hx-dictation, .create-decision')) return true
    if (parent.querySelector('.hx-dictation, button.mic')) return true
  }
  return false
}

function isTextControl(value: HTMLElement): value is TextControl {
  return value instanceof HTMLInputElement || value instanceof HTMLTextAreaElement
}

function voiceTarget(value: EventTarget | null): value is VoiceTarget {
  if (!(value instanceof HTMLElement)) return false
  const editable = value.isContentEditable ? value.closest<HTMLElement>('[contenteditable]') : null
  const target = editable || value
  const isEditable = editable?.contentEditable === 'true' || editable?.contentEditable === 'plaintext-only'
  if (!isEditable && !isTextControl(target)) return false
  if (target.hidden || target.getClientRects().length === 0 || target.getAttribute('aria-hidden') === 'true' || target.closest('[inert], [aria-hidden="true"], [data-voice-input="off"]')) return false
  if (isTextControl(target) && (target.disabled || target.readOnly)) return false
  if (!voiceInputEligible({ tagName: target.tagName, type: target instanceof HTMLInputElement ? target.type : undefined,
    disabled: isTextControl(target) && target.disabled, readOnly: isTextControl(target) && target.readOnly,
    hidden: target.hidden || target.getAttribute('aria-hidden') === 'true', contentEditable: isEditable ? (target as HTMLElement).getAttribute('contenteditable') || 'true' : undefined,
    inlineMic: hasInlineMic(target) })) return false
  return true
}

function targetValue(target: VoiceTarget) {
  return isTextControl(target) ? target.value : target.textContent || ''
}

function targetSelection(target: VoiceTarget) {
  if (isTextControl(target)) return { start: target.selectionStart ?? target.value.length, end: target.selectionEnd ?? target.value.length }
  const selection = window.getSelection()
  if (!selection?.rangeCount || !target.contains(selection.anchorNode) || !target.contains(selection.focusNode)) {
    const length = targetValue(target).length
    return { start: length, end: length }
  }
  const range = selection.getRangeAt(0)
  const before = range.cloneRange()
  before.selectNodeContents(target)
  before.setEnd(range.startContainer, range.startOffset)
  const start = before.toString().length
  return { start, end: start + range.toString().length }
}

function editablePoint(target: HTMLElement, offset: number, affinity: 'start' | 'end') {
  const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT)
  let node = walker.nextNode()
  let remaining = Math.max(0, offset)
  while (node) {
    const length = node.textContent?.length || 0
    if (remaining < length) return { node, offset: remaining }
    if (remaining === length) {
      const next = walker.nextNode()
      if (affinity === 'start' && next) return { node: next, offset: 0 }
      return { node, offset: length }
    }
    remaining -= length
    node = walker.nextNode()
  }
  return { node: target as Node, offset: target.childNodes.length }
}

function setTargetValue(target: VoiceTarget, value: string, caret: number, start: number, end: number) {
  if (!isTextControl(target)) {
    const range = document.createRange()
    const from = editablePoint(target, start, 'start')
    const to = editablePoint(target, end, 'end')
    range.setStart(from.node, from.offset)
    range.setEnd(to.node, to.offset)
    range.deleteContents()
    const inserted = document.createTextNode(value.slice(start, end))
    range.insertNode(inserted)
    const selection = window.getSelection()
    range.setStart(inserted, Math.max(0, Math.min(inserted.length, caret - start)))
    range.collapse(true)
    selection?.removeAllRanges()
    selection?.addRange(range)
    target.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: inserted.data }))
    return
  }
  const prototype = target instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
  if (setter) setter.call(target, value)
  else target.value = value
  target.setSelectionRange(caret, caret)
  target.dispatchEvent(new Event('input', { bubbles: true }))
}

export function HarnessVoiceInput({ userId, api }: { userId: string; api: DictationApi }) {
  const t = useT()
  const [target, setTarget] = useState<VoiceTarget | null>(null)
  const [listening, setListening] = useState(false)
  const [error, setError] = useState(false)
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null)
  const targetRef = useRef<VoiceTarget | null>(null)
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const sessionRef = useRef<{ target: VoiceTarget; handle: Dictation | null; active: boolean; prefix: string; suffix: string; lastValue: string } | null>(null)
  const learningRef = useRef<{ target: VoiceTarget; expected: string; prefix: string; suffix: string; at: number } | null>(null)
  const savingCorrectionRef = useRef(false)
  const dictionaryRef = useRef<Dictionary>({ vocabulary: readDictationVocabulary(userId), corrections: readDictationCorrections(userId), voiceShortcut: readVoiceShortcut(userId), revision: 0 })
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
        const saved = await api.saveDictationVocabulary(pending.vocabulary, pending.corrections, current.revision, current.voiceShortcut)
        dictionaryRef.current = { ...saved, vocabulary: writeDictationVocabulary(userId, saved.vocabulary), corrections: writeDictationCorrections(userId, saved.corrections), voiceShortcut: writeVoiceShortcut(userId, saved.voiceShortcut || readVoiceShortcut(userId)) }
      } catch {
        // Another device may have updated the dictionary. Refresh once, then
        // retry with its revision so a correction never overwrites newer data.
        try {
          const latest = await api.dictationVocabulary()
          if (latest.corrections.some(item => item.from.toLocaleLowerCase() === correction.from.toLocaleLowerCase())) {
            dictionaryRef.current = { ...latest, vocabulary: writeDictationVocabulary(userId, latest.vocabulary), corrections: writeDictationCorrections(userId, latest.corrections), voiceShortcut: writeVoiceShortcut(userId, latest.voiceShortcut || readVoiceShortcut(userId)) }
          } else {
            const retry = add(latest)
            const saved = await api.saveDictationVocabulary(retry.vocabulary, retry.corrections, latest.revision, latest.voiceShortcut)
            dictionaryRef.current = { ...saved, vocabulary: writeDictationVocabulary(userId, saved.vocabulary), corrections: writeDictationCorrections(userId, saved.corrections), voiceShortcut: writeVoiceShortcut(userId, saved.voiceShortcut || readVoiceShortcut(userId)) }
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

  const place = useCallback((field: VoiceTarget | null) => {
    if (!field?.isConnected) { setPosition(null); return }
    const rect = field.getBoundingClientRect()
    const width = 32
    const left = Math.max(8, Math.min(window.innerWidth - width - 8, rect.right - width - 3))
    const top = Math.max(4, Math.min(window.innerHeight - width - 4, rect.top + Math.max(0, (rect.height - width) / 2)))
    setPosition({ top, left })
  }, [])

  useEffect(() => {
    dictionaryRef.current = { vocabulary: readDictationVocabulary(userId), corrections: readDictationCorrections(userId), voiceShortcut: readVoiceShortcut(userId), revision: 0 }
    let cancelled = false
    void api.dictationVocabulary().then(remote => {
      if (cancelled) return
      dictionaryRef.current = { ...remote, vocabulary: writeDictationVocabulary(userId, remote.vocabulary), corrections: writeDictationCorrections(userId, remote.corrections), voiceShortcut: writeVoiceShortcut(userId, remote.voiceShortcut || readVoiceShortcut(userId)) }
    }).catch(() => { /* Use the account-scoped local copy when offline. */ })
    const changed = (event: Event) => {
      const detail = (event as CustomEvent<{ userId?: string; revision?: number }>).detail
      if (detail?.userId !== userId || !Number.isSafeInteger(detail.revision) || Number(detail.revision) <= dictionaryRef.current.revision) return
      void api.dictationVocabulary().then(remote => {
        if (!cancelled && remote.revision >= dictionaryRef.current.revision) dictionaryRef.current = { ...remote, vocabulary: writeDictationVocabulary(userId, remote.vocabulary), corrections: writeDictationCorrections(userId, remote.corrections), voiceShortcut: writeVoiceShortcut(userId, remote.voiceShortcut || readVoiceShortcut(userId)) }
      }).catch(() => { /* Keep the last account-local copy when offline. */ })
    }
    window.addEventListener('honmaru:dictation-vocabulary-changed', changed)
    return () => { cancelled = true; window.removeEventListener('honmaru:dictation-vocabulary-changed', changed); stop() }
  }, [api, userId, stop])

  useEffect(() => {
    if (!canDictate) return
    const activate = (candidate: EventTarget | null) => {
      const next = candidate === buttonRef.current ? targetRef.current : voiceTarget(candidate) ? candidate : null
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
      const value = targetValue(field)
      if (value === pending.expected) return
      if (!value.startsWith(pending.prefix) || pending.suffix && !value.endsWith(pending.suffix)) { learningRef.current = null; return }
      const correction = detectDictationRangeCorrection(pending.expected, value, pending.prefix, pending.suffix, getLocale())
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
    if (voiceTarget(document.activeElement)) activate(document.activeElement)
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
    if (!field?.isConnected || isTextControl(field) && (field.disabled || field.readOnly)) return
    const value = targetValue(field)
    const { start, end } = targetSelection(field)
    let prefix = value.slice(0, start)
    const suffix = value.slice(end)
    if (end === value.length && prefix && !/\s$/u.test(prefix)) prefix += ' '
    const session = { target: field, handle: null as Dictation | null, active: true, prefix, suffix, lastValue: value }
    sessionRef.current = session
    setError(false)
    setListening(true)
    const dictionary = dictionaryRef.current
    const handle = startDictation(getLocale() === 'ja' ? 'ja-JP' : getLocale(), spoken => {
      if (!session.active || sessionRef.current !== session || !field.isConnected || document.activeElement !== field && !field.contains(document.activeElement) && document.activeElement !== buttonRef.current) { stop(); return }
      // Keep the range captured before listening so successive interim
      // transcripts replace one another instead of duplicating words.
      const maxLength = isTextControl(field) ? field.maxLength : Number(field.getAttribute('maxlength') || -1)
      const end = session.lastValue.length - session.suffix.length
      const fixed = dictatedValue(session.lastValue, session.prefix.length, end, spoken, maxLength)
      const value = fixed.value
      learningRef.current = { target: field, expected: value, prefix: session.prefix, suffix: session.suffix, at: Date.now() }
      setTargetValue(field, value, fixed.caret, session.prefix.length, end)
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

  useEffect(() => {
    if (!canDictate) return
    const keydown = (event: KeyboardEvent) => {
      if (event.isComposing || event.repeat || !matchesVoiceShortcut(event, readVoiceShortcut(userId))) return
      const active = document.activeElement
      const activeTarget = voiceTarget(active) ? active : null
      if (active !== buttonRef.current && activeTarget !== targetRef.current) return
      if (!targetRef.current?.isConnected) return
      event.preventDefault()
      event.stopPropagation()
      toggle()
    }
    document.addEventListener('keydown', keydown, true)
    return () => document.removeEventListener('keydown', keydown, true)
  }, [canDictate, toggle, userId])

  if (!canDictate || !target || !position || typeof document === 'undefined') return null
  // A viewport-positioned control must escape the workspace's clipping and
  // stacking contexts so it remains clickable over full-screen panels.
  const portalRoot = document.body
  return createPortal(<>
    <button ref={buttonRef} className={`hx-global-dictation${listening ? ' is-listening' : ''}`} type="button" style={{ top: position.top, left: position.left }} aria-label={t(listening ? 'Stop voice input' : 'Voice input')} aria-pressed={listening} title={t(error ? 'Voice input unavailable. Check microphone access.' : listening ? 'Stop voice input' : 'Voice input')} onMouseDown={event => event.preventDefault()} onClick={toggle}>
      <Icon name={listening ? 'mic-off' : 'mic'} size={16}/>
    </button>
    {error && <span role="status" className="hx-global-dictation-status" style={{ top: position.top + 34, left: Math.max(8, Math.min(window.innerWidth - 248, position.left - 210)) }}>{t('Voice input unavailable. Check microphone access.')}</span>}
  </>, portalRoot)
}
