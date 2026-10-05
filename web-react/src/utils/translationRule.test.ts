import { expect, it } from 'vitest'
import { sameWords, wantsTranslation } from './translationRule'

it('leaves what needs no translation as it is (#220)', () => {
  expect(wantsTranslation('ja', 'ja')).toBe(false)
  expect(wantsTranslation(null, 'ja', 'https://x.com')).toBe(false)
  expect(wantsTranslation('latn', 'en', 'ok thanks')).toBe(false)
  expect(wantsTranslation('latn', 'ja', 'LGTM')).toBe(false)
  expect(wantsTranslation('latn', 'ja', 'ok see you at the station tomorrow')).toBe(true)
  expect(wantsTranslation('zh', 'ja', '了解')).toBe(false)
  expect(wantsTranslation('en', 'ja', 'Autumn menu launches on the 1st')).toBe(true)
})

it('a translation that is the message itself is no translation', () => {
  expect(sameWords('OK, thanks!', 'ok thanks')).toBe(true)
  expect(sameWords('Meet at 3', 'Meet at 4')).toBe(false)
})
