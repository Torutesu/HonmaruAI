import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { getLocale, setLocale, linkedLocale, readerLanguageOptions, languageLabel, isLanguage, browserLanguage } from './locale'

function fakeStorage(): Storage {
  const m = new Map<string, string>()
  return {
    getItem: (k) => (m.has(k) ? m.get(k)! : null),
    setItem: (k, v) => { m.set(k, String(v)) },
    removeItem: (k) => { m.delete(k) },
    clear: () => m.clear(),
    key: (i) => [...m.keys()][i] ?? null,
    get length() { return m.size },
  } as Storage
}

type G = { localStorage?: Storage; location?: { search: string }; navigator?: { language: string } }
const g = globalThis as unknown as G
const saved = { location: g.location, navigator: g.navigator }

function visit(search: string, browser = 'en-US') {
  Object.defineProperty(globalThis, 'location', { value: { search }, configurable: true })
  Object.defineProperty(globalThis, 'navigator', { value: { language: browser }, configurable: true })
}

// Someone arriving from the Japanese landing page reads the app in Japanese,
// until they pick a language in the app themselves.
describe('locale', () => {
  beforeEach(() => { g.localStorage = fakeStorage() })
  afterEach(() => {
    Object.defineProperty(globalThis, 'location', { value: saved.location, configurable: true })
    Object.defineProperty(globalThis, 'navigator', { value: saved.navigator, configurable: true })
  })

  it('follows the linking page over the browser', () => {
    visit('?lang=ja', 'en-US')
    expect(getLocale()).toBe('ja')
  })

  it('lets a choice made in the app win over the link', () => {
    visit('?lang=ja', 'en-US')
    setLocale('de')
    expect(getLocale()).toBe('de')
  })

  it('ignores a language it does not speak, and falls back to the browser', () => {
    visit('?lang=xx', 'fr-FR')
    expect(linkedLocale()).toBeNull()
    expect(getLocale()).toBe('fr')
  })

  it('uses the browser when nothing links', () => {
    visit('', 'ja-JP')
    expect(getLocale()).toBe('ja')
  })
})

// The language a person reads is not limited to the five the screens are in.
describe('reader languages', () => {
  it('offers the screens’ languages first, then every other one', () => {
    const options = readerLanguageOptions('en')
    expect(options.slice(0, 5).map((o) => o.code)).toEqual(['en', 'ja', 'es', 'fr', 'de'])
    expect(options.slice(0, 5).every((o) => o.screens)).toBe(true)
    const vi = options.find((o) => o.code === 'vi')
    expect(vi).toMatchObject({ screens: false })
    expect(vi?.label).not.toBe('vi')
  })

  it('keeps a current language that is not on the list, and refuses made-up ones', () => {
    expect(readerLanguageOptions('yo-NG').some((o) => o.code === 'yo')).toBe(true)
    expect(readerLanguageOptions('xx').some((o) => o.code === 'xx')).toBe(false)
    expect(isLanguage('vi')).toBe(true)
    expect(isLanguage('xx')).toBe(false)
    expect(languageLabel('ja')).toBe('日本語')
  })
})

describe('browser language for onboarding', () => {
  afterEach(() => {
    Object.defineProperty(globalThis, 'location', { value: saved.location, configurable: true })
    Object.defineProperty(globalThis, 'navigator', { value: saved.navigator, configurable: true })
  })

  it('is the linking page’s language first, then any language the browser names', () => {
    visit('?lang=ja', 'vi-VN')
    expect(browserLanguage()).toBe('ja')
    visit('', 'vi-VN')
    expect(browserLanguage()).toBe('vi')
    visit('', 'xx')
    expect(browserLanguage()).toBe('en')
  })
})
