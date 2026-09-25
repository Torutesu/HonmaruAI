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

  it('places languages other than Japanese and English, and does not guess', () => {
    expect(detectLanguage('¿Aprobamos el presupuesto de marketing?')).toBe('es')
    expect(detectLanguage('Bạn có duyệt ngân sách không?')).toBe('vi')
    expect(detectLanguage('อนุมัติงบประมาณไหม')).toBe('th')
    expect(detectLanguage('田中さんの予算 Q3 budget approval')).toBe('ja')
    expect(detectLanguage('Presupuesto Q3')).toBe('und')
  })

  it('asks for a card in any language that is not known to be the reader\'s', () => {
    expect(needsLocalizing({ title: '¿Aprobamos el presupuesto de marketing?', summary: '' }, 'en')).toBe(true)
    expect(needsLocalizing({ title: 'Approve the supplier price', summary: '' }, 'vi')).toBe(true)
    expect(needsLocalizing({ title: '¿Aprobamos el presupuesto de marketing?', summary: '' }, 'es-MX')).toBe(false)
    expect(needsLocalizing({ title: 'Presupuesto Q3', summary: '' }, 'es')).toBe(true)
  })
})
