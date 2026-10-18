import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import React from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { MessageFiles, shrinkPlan, PHOTO_MAX_PIXELS } from './Attachments'
import { renderRich } from './MessageParts'
import type { FileRef } from '../types/card'
import { configureMediaUrls } from '../utils/mediaUrls'

const BASE = 'https://api.example'
const file = (id: string, name: string, type: string, extra: Partial<FileRef> = {}): FileRef =>
  ({ id, name, type, size: 2048, url: `/files/${id}?e=1&s=abc`, ...extra })
const html = (files: FileRef[]) => renderToStaticMarkup(<MessageFiles files={files} base={BASE} />)

// A message's files, as they are drawn before anyone touches them.
describe('MessageFiles', () => {
  it('plays a video where it is, at the shape it was measured at', () => {
    const out = html([file('f_v', 'clip.mp4', 'video/mp4', { width: 1080, height: 1920 })])
    expect(out).toContain(`<video src="${BASE}/files/f_v?e=1&amp;s=abc#t=0.001" controls="" preload="metadata" playsinline="" aria-label="clip.mp4" style="aspect-ratio:0.5625"></video>`)
    expect(out).toMatch(/<figure class="att-media video" style="width:min\(100%, 203px\)"/)
    expect(out).not.toContain('att-pic')
  })

  it('draws a video nobody measured widescreen', () => {
    const out = html([file('f_v', 'screen.webm', 'video/webm')])
    expect(out).toContain('style="aspect-ratio:1.7777777777777777"')
    expect(out).toContain('style="width:min(100%, 400px)"')
  })

  it('plays a song with nothing loaded until it is played', () => {
    const out = html([file('f_a', 'memo.m4a', 'audio/x-m4a')])
    expect(out).toContain(`<audio src="${BASE}/files/f_a?e=1&amp;s=abc" controls="" preload="none" aria-label="memo.m4a"></audio>`)
    expect(out).toContain('class="att-media audio"')
    expect(out).not.toContain('<video')
  })

  it('asks a video, and only a video, for its first frame', () => {
    const out = html([file('f_v', 'clip.mp4', 'video/mp4'), file('f_a', 'memo.m4a', 'audio/x-m4a')])
    expect(out.match(/#t=0.001/g)).toHaveLength(1)
    expect(out).toContain(`href="${BASE}/files/f_v?e=1&amp;s=abc&amp;download=1"`)
  })

  it('names each player and gives a way to save it, labelled', () => {
    const out = html([file('f_v', 'clip.mp4', 'video/mp4')])
    expect(out).toContain('<figcaption class="att-media-about">')
    expect(out).toContain('<span class="att-media-name">clip.mp4</span><small>2 KB</small>')
    expect(out).toContain(`href="${BASE}/files/f_v?e=1&amp;s=abc&amp;download=1"`)
    expect(out).toContain('aria-label="Download clip.mp4"')
    expect(out).toContain('title="Download"')
  })

  it('keeps pictures in their grid and every other file a card, in the order sent', () => {
    const out = html([
      file('f_d', 'notes.pdf', 'application/pdf'),
      file('f_p', 'photo.png', 'image/png', { width: 640, height: 480 }),
      file('f_s', 'song.mp3', 'audio/mpeg'),
      file('f_v', 'clip.mov', 'video/quicktime'),
    ])
    expect(out).toContain('class="att-pics n1"')
    expect(out).toContain('aria-label="Open photo.png"')
    expect(out).toContain(`<a class="att-file" href="${BASE}/files/f_d?e=1&amp;s=abc" target="_blank" rel="noopener noreferrer" data-file="notes.pdf">`)
    const at = (s: string) => out.indexOf(s)
    expect(at('data-file="notes.pdf"')).toBeLessThan(at('data-file="song.mp3"'))
    expect(at('data-file="song.mp3"')).toBeLessThan(at('data-file="clip.mov"'))
  })

  it('never puts a player on what is served as a download', () => {
    const out = html([file('f_x', 'clip.mp4', 'application/octet-stream'), file('f_k', 'film.mkv', 'video/x-matroska')])
    expect(out).not.toContain('<video')
    expect(out).not.toContain('<audio')
    expect(out.match(/class="att-file"/g)).toHaveLength(2)
  })

  it('draws nothing for a message with no files', () => {
    expect(html([])).toBe('')
  })
})

/// As much of a page as React asks of one to draw on: elements that keep
/// their attributes, their children and who is listening to them. Nothing
/// here loads or plays; a test says what the browser would have.
type Listener = (e: unknown) => void
class El {
  nodeType = 1
  namespaceURI = 'http://www.w3.org/1999/xhtml'
  parentNode: El | null = null
  childNodes: El[] = []
  nodeValue: string | null = null
  attrs: Record<string, string> = {}
  style: Record<string, string> = {}
  listeners: Record<string, Listener[]> = {}
  onclick: unknown = null
  /// What a test says the browser found in a player: what went wrong, by
  /// MediaError's number, and how far it had played.
  error: { code: number } | null = null
  currentTime = 0
  /// How many times it was told to play.
  played = 0
  play() { this.played += 1; return Promise.resolve() }
  constructor(public tagName: string, public ownerDocument: Page) {}
  get nodeName() { return this.tagName }
  get firstChild() { return this.childNodes[0] ?? null }
  get lastChild() { return this.childNodes[this.childNodes.length - 1] ?? null }
  set textContent(text: string) {
    for (const c of this.childNodes) c.parentNode = null
    this.childNodes = text ? [this.ownerDocument.createTextNode(text)] : []
  }
  appendChild(c: El) { c.parentNode?.removeChild(c); c.parentNode = this; this.childNodes.push(c); return c }
  insertBefore(c: El, before: El) { c.parentNode?.removeChild(c); c.parentNode = this; this.childNodes.splice(this.childNodes.indexOf(before), 0, c); return c }
  removeChild(c: El) { this.childNodes = this.childNodes.filter((n) => n !== c); c.parentNode = null; return c }
  setAttribute(name: string, value: string) { this.attrs[name] = String(value) }
  removeAttribute(name: string) { delete this.attrs[name] }
  addEventListener(type: string, fn: Listener) { (this.listeners[type] ??= []).push(fn) }
  removeEventListener(type: string, fn: Listener) { this.listeners[type] = (this.listeners[type] ?? []).filter((f) => f !== fn) }
  /// Every element of a tag inside this one, in the order drawn.
  all(tag: string): El[] { return this.childNodes.flatMap((c) => [...(c.tagName === tag ? [c] : []), ...c.all(tag)]) }
}
class Page {
  nodeType = 9
  createElement(tag: string) { return new El(tag, this) }
  createElementNS(ns: string, tag: string) { const e = new El(tag, this); e.namespaceURI = ns; return e }
  createTextNode(text: string) { const e = new El('#text', this); e.nodeType = 3; e.nodeValue = text; return e }
  addEventListener() {}
  removeEventListener() {}
}

/// The window React looks to, before it draws, for what has the focus.
function onPage() {
  beforeAll(() => { vi.stubGlobal('window', { HTMLIFrameElement: class {} }) })
  afterAll(() => { vi.unstubAllGlobals() })
}

/// A message's files drawn on such a page, and drawn again when the
/// message is read again.
function drawn(files: FileRef[]) {
  const box = new Page().createElement('div')
  const root = createRoot(box as unknown as Element)
  const show = (next: FileRef[]) => flushSync(() => root.render(<MessageFiles files={next} base={BASE} />))
  show(files)
  return { box, show, close: () => flushSync(() => root.unmount()) }
}

/// What the browser would tell React of an element, and what it found.
function tell(el: El, type: string, found: { code?: number; at?: number } = {}) {
  if (found.code) el.error = { code: found.code }
  if (found.at !== undefined) el.currentTime = found.at
  flushSync(() => { for (const fn of el.listeners[type] ?? []) fn({ type, target: el }) })
}
/// MediaError's numbers.
const DROPPED = 2, UNREADABLE = 3, UNPLAYABLE = 4

/// The same file a day later: the same id, under a new signed address.
const later = (f: FileRef): FileRef => ({ ...f, url: `/files/${f.id}?e=2&s=xyz` })

// A message's files once they are on the page, as the message under them
// changes.
describe('MessageFiles, read again', () => {
  onPage()

  it('goes on playing a video from the address it started at', () => {
    const clip = file('f_v', 'clip.mp4', 'video/mp4')
    const { box, show, close } = drawn([clip])
    const video = box.all('video')[0]
    expect(video.attrs.src).toBe(`${BASE}/files/f_v?e=1&s=abc#t=0.001`)
    show([later(clip)])
    expect(box.all('video')).toEqual([video])
    expect(video.attrs.src).toBe(`${BASE}/files/f_v?e=1&s=abc#t=0.001`)
    close()
  })

  it('goes on playing a song from the address it started at', () => {
    const memo = file('f_a', 'memo.m4a', 'audio/x-m4a')
    const { box, show, close } = drawn([memo])
    const audio = box.all('audio')[0]
    show([later(memo)])
    expect(box.all('audio')).toEqual([audio])
    expect(audio.attrs.src).toBe(`${BASE}/files/f_a?e=1&s=abc`)
    close()
  })

  it('saves from the newest address all the same', () => {
    const clip = file('f_v', 'clip.mp4', 'video/mp4')
    const { box, show, close } = drawn([clip])
    show([later(clip)])
    expect(box.all('a').map((a) => a.attrs.href)).toEqual([`${BASE}/files/f_v?e=2&s=xyz&download=1`])
    close()
  })

  it('takes the new address when the old one fails, where it had got to', () => {
    const clip = file('f_v', 'clip.mp4', 'video/mp4')
    const { box, show, close } = drawn([clip])
    const video = box.all('video')[0]
    show([later(clip)])
    tell(video, 'error', { code: UNPLAYABLE, at: 12.5 })
    expect(box.all('video')).toEqual([video])
    expect(video.attrs.src).toBe(`${BASE}/files/f_v?e=2&s=xyz#t=0.001`)
    tell(video, 'loadedmetadata', { at: 0 })
    expect(video.currentTime).toBe(12.5)
    close()
  })

  it('makes a card of one this browser cannot play, at any address', () => {
    const clip = file('f_v', 'clip.mp4', 'video/mp4')
    const { box, show, close } = drawn([clip])
    show([later(clip)])
    tell(box.all('video')[0], 'error', { code: UNPLAYABLE })
    expect(box.all('video')).toHaveLength(1)
    tell(box.all('video')[0], 'error', { code: UNPLAYABLE })
    expect(box.all('video')).toHaveLength(0)
    expect(box.all('a').map((a) => [a.attrs.class, a.attrs.href])).toEqual([['att-file', `${BASE}/files/f_v?e=2&s=xyz&download=1`]])
    close()
  })

  it('makes a card of one whose bytes do not decode', () => {
    const { box, close } = drawn([file('f_a', 'memo.m4a', 'audio/x-m4a')])
    tell(box.all('audio')[0], 'error', { code: UNREADABLE })
    expect(box.all('audio')).toHaveLength(0)
    expect(box.all('a')[0].attrs.class).toBe('att-file')
    close()
  })
})

// A connection that goes while something is playing.
describe('MessageFiles, when the connection drops', () => {
  onPage()

  it('keeps the player, as one that waits to be played again', () => {
    const { box, close } = drawn([file('f_v', 'clip.mp4', 'video/mp4')])
    const video = box.all('video')[0]
    expect(video.attrs.preload).toBe('metadata')
    tell(video, 'error', { code: DROPPED, at: 42 })
    const [again] = box.all('video')
    expect(again).not.toBe(video)
    expect(again.attrs.preload).toBe('none')
    expect(again.attrs.src).toBe(video.attrs.src)
    expect(box.all('a').map((a) => a.attrs.class)).toEqual(['att-media-save'])
    close()
  })

  it('goes on from where it had got to', () => {
    const { box, close } = drawn([file('f_a', 'memo.m4a', 'audio/x-m4a')])
    tell(box.all('audio')[0], 'error', { code: DROPPED, at: 42 })
    const again = box.all('audio')[0]
    expect(again.currentTime).toBe(0)
    tell(again, 'loadedmetadata')
    expect(again.currentTime).toBe(42)
    // Only the once: a seek back to the start is not undone by a later load.
    again.currentTime = 0
    tell(again, 'loadedmetadata')
    expect(again.currentTime).toBe(0)
    close()
  })

  it('does not take being played with still no connection for a file it cannot play', () => {
    const { box, close } = drawn([file('f_v', 'clip.mp4', 'video/mp4')])
    tell(box.all('video')[0], 'error', { code: DROPPED, at: 42 })
    const again = box.all('video')[0]
    tell(again, 'error', { code: UNPLAYABLE })
    const third = box.all('video')[0]
    expect(third).not.toBe(again)
    expect(third.attrs.preload).toBe('none')
    tell(third, 'loadedmetadata')
    expect(third.currentTime).toBe(42)
    close()
  })

  it('takes up the newest address as it waits', () => {
    const clip = file('f_v', 'clip.mp4', 'video/mp4')
    const { box, show, close } = drawn([clip])
    show([later(clip)])
    tell(box.all('video')[0], 'error', { code: DROPPED, at: 42 })
    expect(box.all('video')[0].attrs.src).toBe(`${BASE}/files/f_v?e=2&s=xyz#t=0.001`)
    close()
  })

  it('still makes a card of bytes that stop decoding after it', () => {
    const { box, close } = drawn([file('f_v', 'clip.mp4', 'video/mp4')])
    tell(box.all('video')[0], 'error', { code: DROPPED, at: 42 })
    tell(box.all('video')[0], 'error', { code: UNREADABLE })
    expect(box.all('video')).toHaveLength(0)
    expect(box.all('a')[0].attrs.class).toBe('att-file')
    close()
  })
})

// A Jam's recording in a message left open far longer than its address lasts.
describe('a Jam recording, left open', () => {
  onPage()
  const link = 'https://api.example/channels/jam/audio/0f8b3c3e-1111-4222-8333-944455556666'
  const settled = () => new Promise((r) => setTimeout(r, 20))

  it('asks for a new address when played after its own ran out, and when one will not open', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const start = Date.now()
    let n = 0
    let answer: (n: number) => Response = (i) => new Response(JSON.stringify({ url: `${link}?v=2&e=${i}&s=x`, expiresAt: Date.now() + 600_000 }))
    const fetching = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => answer(++n))
    configureMediaUrls({ httpBase: BASE, orgId: 'team:jam', sessionToken: 'tok' })
    const box = new Page().createElement('div')
    const root = createRoot(box as unknown as Element)
    try {
      flushSync(() => root.render(<>{renderRich(`Recording: ${link}`, () => 'mention')}</>))
      await settled()
      const audio = box.all('audio')[0]
      expect(audio.attrs.src).toBe(`${link}?v=2&e=1&s=x`)
      // Played well before it runs out: nothing asked.
      tell(audio, 'play')
      tell(audio, 'pause')
      await settled()
      expect(n).toBe(1)

      // Played for the first time an hour later: a new address, and it plays.
      vi.setSystemTime(start + 3_600_000)
      tell(audio, 'play')
      await settled()
      expect(n).toBe(2)
      expect(audio.attrs.src).toBe(`${link}?v=2&e=2&s=x`)
      expect(audio.played).toBe(1)
      tell(audio, 'playing')

      // Its address refused part way through: a new one, from where it was.
      tell(audio, 'error', { code: UNPLAYABLE, at: 31.5 })
      await settled()
      expect(audio.attrs.src).toBe(`${link}?v=2&e=3&s=x`)
      expect(audio.played).toBe(2)
      tell(audio, 'loadedmetadata', { at: 0 })
      expect(audio.currentTime).toBe(31.5)

      // No longer this reader's: asked once, and never again.
      answer = () => new Response(JSON.stringify({ message: 'No such recording.' }), { status: 404 })
      tell(audio, 'error', { code: UNPLAYABLE })
      await settled()
      expect(n).toBe(4)
      expect(audio.attrs.src).toBe(`${link}?v=2&e=3&s=x`)
      tell(audio, 'error', { code: UNPLAYABLE })
      vi.setSystemTime(start + 7_200_000)
      tell(audio, 'play')
      await settled()
      expect(n).toBe(4)
    } finally {
      flushSync(() => root.unmount())
      fetching.mockRestore()
      configureMediaUrls(null)
      vi.useRealTimers()
    }
  })

  it('gets an address on being played when asking for one failed before', async () => {
    let up = false
    const fetching = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      if (!up) throw new TypeError('Failed to fetch')
      return new Response(JSON.stringify({ url: `${link}?v=2&e=9&s=x`, expiresAt: Date.now() + 600_000 }))
    })
    configureMediaUrls({ httpBase: BASE, orgId: 'team:jam', sessionToken: 'tok' })
    const box = new Page().createElement('div')
    const root = createRoot(box as unknown as Element)
    try {
      flushSync(() => root.render(<>{renderRich(`Recording: ${link}`, () => 'mention')}</>))
      await settled()
      const audio = box.all('audio')[0]
      expect(audio.attrs.src).toBeUndefined()
      up = true
      tell(audio, 'play')
      await settled()
      expect(audio.attrs.src).toBe(`${link}?v=2&e=9&s=x`)
      expect(audio.played).toBe(1)
    } finally {
      flushSync(() => root.unmount())
      fetching.mockRestore()
      configureMediaUrls(null)
    }
  })
})

// A message's files on a page left open while their addresses run out.
describe('MessageFiles, kept fresh', () => {
  onPage()

  it('asks again for an address it could not renew, until it is taken off the page', async () => {
    vi.useFakeTimers()
    const calls: number[] = []
    const fetching = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { calls.push(Date.now()); throw new TypeError('Failed to fetch') })
    configureMediaUrls({ httpBase: BASE, orgId: 'team:fresh', sessionToken: 'tok' })
    try {
      const pic = file('f_eeeeeeeeeeeeeeeeeeeeeeee', 'p.png', 'image/png', { expiresAt: Date.now() + 30_000 })
      const { close } = drawn([pic])
      await vi.advanceTimersByTimeAsync(100)
      expect(calls).toHaveLength(1)
      // Offline when it was due: asked again ten seconds on, then twenty.
      await vi.advanceTimersByTimeAsync(10_500)
      expect(calls).toHaveLength(2)
      await vi.advanceTimersByTimeAsync(20_500)
      expect(calls).toHaveLength(3)
      close()
      await vi.advanceTimersByTimeAsync(600_000)
      expect(calls).toHaveLength(3)
    } finally {
      fetching.mockRestore()
      configureMediaUrls(null)
      vi.useRealTimers()
    }
  })
})

// A phone's photo is several megabytes and twelve megapixels or more: that
// is what made it slow to go up. It is redrawn at a sensible size first.
describe('which pictures are made smaller before they go up', () => {
  it('redraws a large photo at the long side the app sends, keeping its shape', () => {
    expect(shrinkPlan('image/jpeg', 4_800_000, { width: 4032, height: 3024 })).toEqual({ width: PHOTO_MAX_PIXELS, height: 1920 })
    expect(shrinkPlan('image/heic', 2_000_000, { width: 3024, height: 4032 })).toEqual({ width: 1920, height: PHOTO_MAX_PIXELS })
  })
  it('recompresses a heavy photo already small enough in pixels, without making it larger', () => {
    expect(shrinkPlan('image/jpeg', 3_000_000, { width: 2000, height: 1500 })).toEqual({ width: 2000, height: 1500 })
  })
  it('sends a light photo, a screenshot and a moving picture as they are', () => {
    expect(shrinkPlan('image/jpeg', 400_000, { width: 1600, height: 1200 })).toBeNull()
    expect(shrinkPlan('image/png', 6_000_000, { width: 3000, height: 2000 })).toBeNull()
    expect(shrinkPlan('image/gif', 6_000_000, { width: 3000, height: 2000 })).toBeNull()
    expect(shrinkPlan('application/pdf', 6_000_000, { width: 3000, height: 2000 })).toBeNull()
  })
})
