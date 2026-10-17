import { afterEach, expect, test, vi } from 'vitest'
import { readAppPins } from './appPins'
afterEach(() => vi.unstubAllGlobals())
test('pins are bounded identifiers scoped to the requested workspace', () => {
  const getItem = vi.fn().mockReturnValue(JSON.stringify(['app1', '<script>', null, ...Array.from({length: 12}, (_, i) => `app_${i}`)]))
  vi.stubGlobal('localStorage', { getItem })
  const pins = readAppPins('personal:a')
  expect(getItem).toHaveBeenCalledWith('hx.appPins:personal:a')
  expect(pins).toHaveLength(8)
  expect(pins).not.toContain('<script>')
})
test('unavailable storage does not prevent loading the app', () => {
  vi.stubGlobal('localStorage', { getItem: () => { throw Error('blocked') } })
  expect(readAppPins('org')).toEqual([])
})
