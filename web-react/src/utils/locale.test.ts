import { describe, it, expect } from 'vitest'
import { readerLanguageOptions, languageLabel, isLanguage } from './locale'

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
