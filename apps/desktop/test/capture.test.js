import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { captureAllowed, captureBlocked, captureBlockedMessage, captureChoices } from '../src/capture.js'

const APP = 'https://app.honmaruai.com'
const read = (path) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')

describe('who may share a screen', () => {
  it('is the app\'s own page', () => {
    expect(captureAllowed({ securityOrigin: 'https://app.honmaruai.com/', frame: { url: 'https://app.honmaruai.com/#/c/general' } }, APP)).toBe(true)
    expect(captureAllowed({ frame: { url: 'https://app.honmaruai.com/#/c/general' } }, APP)).toBe(true)
  })

  it('is not a frame on the page from somewhere else, a sign-in page, or a request that cannot say where it is from', () => {
    expect(captureAllowed({ securityOrigin: 'https://www.youtube-nocookie.com', frame: { url: 'https://www.youtube-nocookie.com/embed/x' } }, APP)).toBe(false)
    expect(captureAllowed({ securityOrigin: 'https://login.company.example' }, APP)).toBe(false)
    expect(captureAllowed({ securityOrigin: 'null' }, APP)).toBe(false)
    expect(captureAllowed({ frame: null }, APP)).toBe(false)
    expect(captureAllowed(null, APP)).toBe(false)
  })
})

describe('the screen recording permission on a Mac', () => {
  it('stops sharing only when the person turned it off, or it is not theirs to turn on', () => {
    expect(captureBlocked('denied')).toBe(true)
    expect(captureBlocked('restricted')).toBe(true)
    expect(captureBlocked('granted')).toBe(false)
    expect(captureBlocked('not-determined')).toBe(false)
    expect(captureBlocked('unknown')).toBe(false)
  })

  it('says where to turn it on', () => {
    const m = captureBlockedMessage({ appName: 'Honmaru AI' })
    expect(m.detail).toMatch(/System Settings/)
    expect(m.buttons[m.cancelId]).toBe('Cancel')
    expect(captureBlockedMessage({ japanese: true }).buttons[0]).toBe('システム設定を開く')
  })
})

describe('which screen or window to share', () => {
  const sources = [
    { id: 'window:12:0', name: 'Notes' },
    { id: 'screen:1:0', name: 'Screen 2' },
    { id: 'screen:0:0', name: 'Entire Screen' },
    { id: 'window:40:0', name: '' },
  ]

  it('offers the screens, then the windows, then Cancel', () => {
    const c = captureChoices(sources)
    expect(c.options.buttons).toEqual(['Screen 2', 'Entire Screen', 'Notes', 'Untitled window', 'Cancel'])
    expect(c.options.cancelId).toBe(4)
    expect(c.options.defaultId).toBe(0)
  })

  it('shares the one chosen', () => {
    const c = captureChoices(sources)
    expect(c.pick(0).id).toBe('screen:1:0')
    expect(c.pick(2).id).toBe('window:12:0')
  })

  it('shares nothing when the question is cancelled or closed', () => {
    const c = captureChoices(sources)
    expect(c.pick(c.options.cancelId)).toBeNull()
    expect(c.pick(-1)).toBeNull()
    expect(c.pick(undefined)).toBeNull()
  })

  it('with nothing to share, offers only Cancel', () => {
    const c = captureChoices([])
    expect(c.options.buttons).toEqual(['Cancel'])
    expect(c.options.defaultId).toBe(0)
    expect(c.pick(0)).toBeNull()
    expect(captureChoices(undefined).sources).toEqual([])
  })

  it('asks in Japanese for a Japanese system', () => {
    const c = captureChoices([{ id: 'screen:0:0', name: '' }, { id: 'window:1:0', name: 'メモ' }], { japanese: true })
    expect(c.options.buttons).toEqual(['画面 1', 'メモ', 'キャンセル'])
  })
})

// The page offers "Share your screen" only in a shell that answers it, and
// a shell answers it only for the app's own page (src/main.js).
describe('the shell wired for screen sharing', () => {
  const main = read('../src/main.js')
  const preload = read('../src/preload.cjs')

  it('answers getDisplayMedia, for the app\'s own page only', () => {
    expect(main).toMatch(/setDisplayMediaRequestHandler\(/)
    expect(main).toMatch(/captureAllowed\(request, APP_ORIGIN\)/)
    expect(main).toMatch(/'display-capture'/)
  })

  it('tells the page it can', () => {
    expect(preload).toMatch(/screenShare: true/)
  })
})
