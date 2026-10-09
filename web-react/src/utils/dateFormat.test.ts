import { describe, it, expect } from 'vitest'
import { dateFormat, formatDate } from './dateFormat'

// A kept formatter says exactly what toLocale*String says for the same
// fields, in each language the app ships, and is made once.
describe('dateFormat', () => {
  const at = new Date(Date.UTC(2026, 9, 1, 3, 4, 0))
  const cases: Array<[Intl.DateTimeFormatOptions, (d: Date, l: string) => string]> = [
    [{ hour: 'numeric', minute: '2-digit' }, (d, l) => d.toLocaleTimeString(l, { hour: 'numeric', minute: '2-digit' })],
    [{ month: 'short', day: 'numeric' }, (d, l) => d.toLocaleDateString(l, { month: 'short', day: 'numeric' })],
    [{ weekday: 'long', month: 'long', day: 'numeric' }, (d, l) => d.toLocaleDateString(l, { weekday: 'long', month: 'long', day: 'numeric' })],
    [{ dateStyle: 'full', timeStyle: 'short' }, (d, l) => d.toLocaleString(l, { dateStyle: 'full', timeStyle: 'short' })],
  ]
  for (const locale of ['en-US', 'ja-JP', 'es', 'fr', 'de']) {
    it(`matches toLocale*String in ${locale}`, () => {
      for (const [options, native] of cases) expect(formatDate(at, locale, options)).toBe(native(at, locale))
    })
  }

  it('makes one formatter per locale and options, and tells them apart', () => {
    const a = dateFormat('en-US', { hour: 'numeric', minute: '2-digit' })
    expect(dateFormat('en-US', { hour: 'numeric', minute: '2-digit' })).toBe(a)
    expect(dateFormat('ja-JP', { hour: 'numeric', minute: '2-digit' })).not.toBe(a)
    expect(dateFormat('en-US', { hour: '2-digit', minute: '2-digit' })).not.toBe(a)
    expect(dateFormat(undefined, { hour: 'numeric' })).toBe(dateFormat([], { hour: 'numeric' }))
  })

  it('says a date that is not one the way toLocaleString does, without throwing', () => {
    expect(formatDate(NaN, 'en-US', { hour: 'numeric' })).toBe(new Date(NaN).toLocaleTimeString('en-US', { hour: 'numeric' }))
    expect(formatDate(new Date('nope'), 'ja-JP', { month: 'short' })).toBe('Invalid Date')
  })
})
