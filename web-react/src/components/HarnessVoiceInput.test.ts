import { describe, expect, it } from 'vitest'
import { dictatedValue, voiceInputEligible } from './HarnessVoiceInput'

describe('Harness voice input coverage', () => {
  it('offers voice on ordinary text fields and excludes private, disabled, and already-mic fields', () => {
    expect(voiceInputEligible({ tagName: 'textarea' })).toBe(true)
    for (const type of ['text', 'search', 'email', 'url', 'tel']) expect(voiceInputEligible({ tagName: 'input', type })).toBe(true)
    for (const type of ['password', 'hidden', 'file', 'checkbox', 'number']) expect(voiceInputEligible({ tagName: 'input', type })).toBe(false)
    expect(voiceInputEligible({ tagName: 'input', type: 'text', disabled: true })).toBe(false)
    expect(voiceInputEligible({ tagName: 'input', type: 'text', hidden: true })).toBe(false)
    expect(voiceInputEligible({ tagName: 'textarea', readOnly: true })).toBe(false)
    expect(voiceInputEligible({ tagName: 'textarea', inlineMic: true })).toBe(false)
    expect(voiceInputEligible({ tagName: 'div', contentEditable: 'true' })).toBe(true)
    expect(voiceInputEligible({ tagName: 'div', contentEditable: 'plaintext-only' })).toBe(true)
    expect(voiceInputEligible({ tagName: 'div', contentEditable: 'false' })).toBe(false)
  })

  it('replaces a selected range, keeps surrounding text, and places the caret after speech', () => {
    expect(dictatedValue('Send draft today', 5, 10, 'the final report')).toEqual({ value: 'Send the final report today', caret: 21, truncated: false })
  })

  it('adds a separating space at the end and clamps speech to the field limit', () => {
    expect(dictatedValue('Send draft', 10, 10, 'today')).toEqual({ value: 'Send draft today', caret: 16, truncated: false })
    expect(dictatedValue('A', 1, 1, 'long spoken text', 8)).toEqual({ value: 'A long s', caret: 8, truncated: true })
  })

  it('preserves the original suffix while interim speech is replaced', () => {
    const first = dictatedValue('beforeafter', 6, 6, 'hello')
    const next = dictatedValue(first.value, 6, first.value.length - 5, 'hello there')
    expect(next.value).toBe('beforehello thereafter')
  })
})
