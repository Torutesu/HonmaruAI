import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type React from 'react'
import { longPress } from './Sheet'

// A held press on a message, on a phone: what opens the sheet of things to
// do to it, and what is left to the control that was under the finger.

/// As much of an element as longPress asks of one: its tag, what it is
/// inside, and closest() over a list of tags.
interface Node { tag: string; parent?: Node; closest: (selector: string) => Node | null }
function el(tag: string, parent?: Node): Node {
  const node: Node = {
    tag,
    parent,
    closest: (selector) => {
      const tags = selector.split(',').map((s) => s.trim())
      for (let n: Node | undefined = node; n; n = n.parent) if (tags.includes(n.tag)) return n
      return null
    },
  }
  return node
}

const article = el('article')
const words = el('p', article)
const video = el('video', el('figure', article))
const audio = el('audio', el('figure', article))
const picture = el('img', el('button', article))
const card = el('span', el('a', article))
/// The name under a player: part of the message, not of the player.
const caption = el('span', el('figcaption', el('figure', article)))

const touch = (target: Node, x = 100, y = 100) => ({ target, touches: [{ clientX: x, clientY: y }] }) as unknown as React.TouchEvent<HTMLElement>
const menu = (target: Node) => {
  const e = { target, preventDefault: vi.fn() }
  return e as unknown as React.MouseEvent<HTMLElement> & { preventDefault: ReturnType<typeof vi.fn> }
}

describe('longPress', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  const held = (target: Node) => {
    const fn = vi.fn()
    longPress(fn).onTouchStart!(touch(target))
    vi.advanceTimersByTime(600)
    return fn
  }

  it('opens the sheet when a message is held for half a second', () => {
    const fn = vi.fn()
    longPress(fn).onTouchStart!(touch(words))
    vi.advanceTimersByTime(470)
    expect(fn).not.toHaveBeenCalled()
    vi.advanceTimersByTime(20)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('is a scroll when the finger moves, and a tap when it lifts', () => {
    const scrolled = vi.fn()
    const a = longPress(scrolled)
    a.onTouchStart!(touch(words))
    a.onTouchMove!(touch(words, 100, 120))
    const tapped = vi.fn()
    const b = longPress(tapped)
    b.onTouchStart!(touch(words))
    b.onTouchEnd!(touch(words))
    vi.advanceTimersByTime(600)
    expect(scrolled).not.toHaveBeenCalled()
    expect(tapped).not.toHaveBeenCalled()
  })

  it('leaves a held scrubber, volume or play button to the player', () => {
    // A touch on a player's own controls arrives as a touch on the player.
    expect(held(video)).not.toHaveBeenCalled()
    expect(held(audio)).not.toHaveBeenCalled()
  })

  it('leaves a picture and a file card to themselves, as before', () => {
    expect(held(picture)).not.toHaveBeenCalled()
    expect(held(card)).not.toHaveBeenCalled()
  })

  it('still opens from the name under a player', () => {
    expect(held(caption)).toHaveBeenCalledTimes(1)
  })

  it('keeps the browser\'s own menu over a video or a song', () => {
    for (const target of [video, audio, card]) {
      const fn = vi.fn()
      const e = menu(target)
      longPress(fn).onContextMenu!(e)
      expect(e.preventDefault).not.toHaveBeenCalled()
      expect(fn).not.toHaveBeenCalled()
    }
  })

  it('opens the sheet in place of the menu over the message itself', () => {
    const fn = vi.fn()
    const e = menu(words)
    longPress(fn).onContextMenu!(e)
    expect(e.preventDefault).toHaveBeenCalledTimes(1)
    expect(fn).toHaveBeenCalledTimes(1)
  })


  it('allows an explicitly opted-in navigation button to receive a held press', () => {
    const button = el('button', article)
    expect(held(button)).not.toHaveBeenCalled()
    const fn = vi.fn()
    longPress(fn, { allowButton: true }).onTouchStart!(touch(button))
    vi.advanceTimersByTime(500)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('is nothing at all when there is nothing to open', () => {
    expect(longPress(undefined)).toEqual({})
  })
})
