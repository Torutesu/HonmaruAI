import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { JumpToPresent } from './JumpToPresent'
import { countNewBelow, isAtBottom, shouldFollow, type Said } from '../utils/chatScroll'

/// A log that keeps up with what arrives, by the conversation's rules
/// (chatScroll): at the bottom it follows the newest line, and your own
/// always; scrolled up it keeps the reader's place and holds "Jump to
/// present" at its foot, with how many new lines wait below. A thread's
/// replies use it: they used to arrive below the fold and stay there (#235).
///
/// `openKey` is what is shown (a thread's parent): a new one is opened at
/// its newest line. `said` is what is in it, oldest first.
export function FollowingLog({ openKey, said, onHandOn, children, ...div }: {
  openKey: string
  said: ReadonlyArray<Said>
  /// The jump was pressed from the keyboard: hand the focus on to the box.
  onHandOn?: () => void
  children: React.ReactNode
} & Omit<React.HTMLAttributes<HTMLDivElement>, 'onScroll' | 'children'>) {
  const ref = useRef<HTMLDivElement | null>(null)
  // At the bottom, so what changes size above keeps the newest in view.
  const pinned = useRef(true)
  // Up in the history: the newest line there was when the reader left.
  const [since, setSince] = useState<string | null>(null)
  const followed = useRef<{ key: string; newestAt: string } | null>(null)
  const newest = said[said.length - 1]

  // Before paint, so a line arriving is never drawn once out of place.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const last = followed.current
    const opened = !last || last.key !== openKey
    const newestIsMine = Boolean(newest?.mine && newest.createdAt > (last?.newestAt || ''))
    followed.current = { key: openKey, newestAt: newest?.createdAt || '' }
    if (opened) setSince(null)
    if (shouldFollow({ opened, atBottom: pinned.current, restoring: false, newestIsMine })) {
      el.scrollTop = el.scrollHeight
      pinned.current = true
      if (!opened) setSince(null)
    }
  }, [openKey, said.length, newest?.id, newest?.createdAt, newest?.mine])

  // Pictures loading, a translation replacing the words, a preview
  // growing under a link: still at the bottom afterwards.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const settle = () => { if (pinned.current) el.scrollTop = el.scrollHeight }
    const changed = typeof MutationObserver !== 'undefined' ? new MutationObserver(settle) : null
    changed?.observe(el, { childList: true, subtree: true, characterData: true })
    const sized = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(settle) : null
    sized?.observe(el)
    // A picture's load does not bubble; caught on the way down.
    el.addEventListener('load', settle, true)
    return () => {
      changed?.disconnect()
      sized?.disconnect()
      el.removeEventListener('load', settle, true)
    }
  }, [])

  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const at = isAtBottom(e.currentTarget)
    pinned.current = at
    if (at) { if (since !== null) setSince(null) } else if (since === null) setSince(newest?.createdAt || '')
  }
  const jump = (handOn: boolean) => {
    const el = ref.current
    if (!el) return
    const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    el.scrollTo({ top: el.scrollHeight, behavior: still ? 'auto' : 'smooth' })
    if (handOn) onHandOn?.()
  }

  return (
    <div ref={ref} {...div} onScroll={onScroll}>
      {children}
      {since !== null && <JumpToPresent count={countNewBelow(said, since)} onJump={jump} />}
    </div>
  )
}
