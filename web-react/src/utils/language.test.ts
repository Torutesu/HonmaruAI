import { describe, it, expect } from 'vitest'
import { detectLanguage, needsLocalizing } from './language'

// Which cards get asked about, and which are left alone.
describe('language', () => {
  it('reads the script', () => {
    expect(detectLanguage('Approve the supplier price')).toBe('en')
    expect(detectLanguage('仕入価格を承認して')).toBe('ja')
    expect(detectLanguage('   ')).toBeNull()
  })

  it('asks only for a card in another language with no translation yet', () => {
    expect(needsLocalizing({ title: 'Approve the supplier price', summary: '' }, 'ja')).toBe(true)
    expect(needsLocalizing({ title: 'Approve the supplier price', summary: '' }, 'en')).toBe(false)
    expect(needsLocalizing({ title: '承認が必要です', summary: '', localized: { en: { title: 'Approval needed' } } }, 'en')).toBe(false)
    expect(needsLocalizing({ title: '承認が必要です', summary: '' }, 'en')).toBe(true)
  })
})
