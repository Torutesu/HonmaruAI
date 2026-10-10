import { describe, it, expect } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { PaneResizer, clampWidth, keyWidth, PANE_MIN } from './PaneResizer'

// The thread pane's edge: what a drag or a key can make of its width.
describe('PaneResizer', () => {
  it('keeps a width between the narrowest that fits and the room there is', () => {
    expect(clampWidth(100, 800)).toBe(PANE_MIN)
    expect(clampWidth(500.4, 800)).toBe(500)
    expect(clampWidth(1200, 800)).toBe(800)
    // No room at all still leaves the pane usable.
    expect(clampWidth(500, 100)).toBe(PANE_MIN)
  })

  it('widens with ← and narrows with →, further with Shift and the page keys', () => {
    expect(keyWidth('ArrowLeft', 440, 900)).toBe(464)
    expect(keyWidth('ArrowRight', 440, 900)).toBe(416)
    expect(keyWidth('ArrowLeft', 440, 900, true)).toBe(536)
    expect(keyWidth('PageDown', 440, 900)).toBe(344)
    expect(keyWidth('ArrowLeft', 890, 900)).toBe(900)
  })

  it('goes to the widest with Home and the narrowest with End, and ignores other keys', () => {
    expect(keyWidth('Home', 440, 900)).toBe(900)
    expect(keyWidth('End', 440, 900)).toBe(PANE_MIN)
    expect(keyWidth('a', 440, 900)).toBeNull()
    expect(keyWidth('Tab', 440, 900)).toBeNull()
  })

  it('is a focusable vertical separator that says what it resizes', () => {
    const html = renderToStaticMarkup(<PaneResizer pane={{ current: null }} label="Resize thread" onWidth={() => {}} onReset={() => {}} />)
    expect(html).toContain('role="separator"')
    expect(html).toContain('aria-orientation="vertical"')
    expect(html).toContain('aria-label="Resize thread"')
    expect(html).toContain('tabindex="0"')
    expect(html).toContain(`aria-valuemin="${PANE_MIN}"`)
  })
})
