import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Icon } from './Icon'
import type { IconName } from './Icon'
import { composing, enterKey } from '../utils/keys'

/// A menu that opens where you right-clicked, the way a desktop chat app's
/// does: items, a line between groups, a small heading, a tick beside the
/// choice that is on, and a submenu that opens to the side. Escape, a click
/// elsewhere or a scroll closes it; the arrow keys walk it.
///
/// A strip is a row of small buttons side by side — a message's quick
/// reactions, along the top as Discord has them. ← and → walk along it;
/// ↑ and ↓ take the whole row as one item.

export type MenuEntry =
  | { kind: 'item'; label: string; identity?: string; onSelect?: () => void; icon?: IconName; checked?: boolean; danger?: boolean; hint?: string; submenu?: MenuEntry[]; data?: string; disabled?: boolean }
  | { kind: 'sep' }
  | { kind: 'head'; label: string }
  | { kind: 'strip'; label: string; items: StripItem[] }

/// One button in a strip: a character (an emoji) or an icon, and what it
/// is called for a screen reader and on hover.
export interface StripItem { label: string; text?: string; icon?: IconName; onSelect: () => void; data?: string }

interface Props {
  at: { x: number; y: number }
  entries: MenuEntry[]
  label: string
  anchor?: HTMLElement
  onClose: () => void
}

/// Where a box opened at a point goes so that all of it is on screen: at
/// the point, or moved in from the right or bottom edge it would run past,
/// a few pixels clear of every edge.
export function keepOnScreen(at: { x: number; y: number }, size: { width: number; height: number }, view: { width: number; height: number }, margin = 4): { left: number; top: number } {
  return {
    left: Math.max(margin, Math.min(at.x, view.width - size.width - margin)),
    top: Math.max(margin, Math.min(at.y, view.height - size.height - margin)),
  }
}

/// One step along a list of `n` from the one at `at`, round from one end
/// to the other: ↓ and → forward, ↑ and ← back. From none (-1), forward is
/// the first and back the last.
export function step(at: number, n: number, forward: boolean): number {
  if (n <= 0) return -1
  if (at < 0 || at >= n) return forward ? 0 : n - 1
  return (at + (forward ? 1 : n - 1)) % n
}

/// Whether a menu, shutting, hands the focus back to what had it when it
/// opened: when that is still on the page, and nothing has taken the focus
/// since — it is on the page's body, where it falls when what had it goes,
/// or still in the menu. A pick that took it (the box to edit a message in,
/// a dialog's first field) keeps it.
export function focusGoesBack<N>(before: { isConnected: boolean } | null, now: N | null, body: N | null, menu: { contains(node: N): boolean } | null): boolean {
  if (!before?.isConnected) return false
  return !now || now === body || Boolean(menu?.contains(now))
}

// A strip counts once, by its first button, so ↑ and ↓ step over it whole.
const items = (el: HTMLElement | null) => (el ? [...el.querySelectorAll<HTMLButtonElement>(':scope > li > button:not([disabled]), :scope > li > [role="group"] > button:first-child')] : [])

/// ← and → along a strip, round from one end to the other.
const walkStrip = (e: React.KeyboardEvent<HTMLElement>) => {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
  const all = [...e.currentTarget.querySelectorAll<HTMLButtonElement>(':scope > button')]
  e.preventDefault(); e.stopPropagation()
  all[step(all.indexOf(document.activeElement as HTMLButtonElement), all.length, e.key === 'ArrowRight')]?.focus()
}

function List({ entries, onClose, onBack, level, label }: { entries: MenuEntry[]; onClose: () => void; onBack?: () => void; level: number; label?: string }) {
  const ref = useRef<HTMLUListElement>(null)
  const focused = useRef<HTMLElement | null>(null)
  // A live update can remove the focused action. Return focus to the menu
  // itself, not another action: a held Enter/Space must not execute it.
  // A deliberate blur to the page clears the reference before an update.
  const recoverFocus = () => {
    const before = focused.current
    if (!before || before.isConnected || document.activeElement !== document.body || !document.hasFocus()) return
    focused.current = null
    ref.current?.focus({ preventScroll: true })
  }
  useLayoutEffect(recoverFocus)
  // If the update happened in a background window, recover only when the
  // user returns to this window and focus has not moved elsewhere.
  useEffect(() => { window.addEventListener('focus', recoverFocus); return () => window.removeEventListener('focus', recoverFocus) }, [])
  // Conditional entries can arrive while the menu is open. Keep the same
  // action attached to its DOM node and to an open submenu across updates.
  const [open, setOpen] = useState<string | null>(null)
  const seen = new Map<string, number>()
  const identity = (entry: MenuEntry | undefined): string => {
    if (!entry) return 'end'
    if (entry.kind === 'sep') return 'separator'
    if (entry.kind === 'item') return `item:${JSON.stringify([entry.identity ?? entry.data ?? entry.label, entry.label])}`
    return `${entry.kind}:${entry.label}`
  }
  const keys = entries.map((entry, i) => {
    // A separator is tied to the group following it; it has no action.
    const name = entry.kind === 'sep' ? `sep:${identity(entries.slice(i + 1).find(next => next.kind !== 'sep'))}` : identity(entry)
    const occurrence = seen.get(name) ?? 0
    seen.set(name, occurrence + 1)
    return `${name}:${occurrence}`
  })
  useEffect(() => { if (open !== null && !keys.includes(open)) setOpen(null) })
  const [flip, setFlip] = useState(false)
  const closeSubmenuTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cancelSubmenuClose = () => {
    if (closeSubmenuTimer.current !== null) clearTimeout(closeSubmenuTimer.current)
    closeSubmenuTimer.current = null
  }
  const delaySubmenuClose = () => {
    cancelSubmenuClose()
    // A submenu is positioned beside its parent, leaving a small diagonal
    // pointer path between the two. Keep it open long enough to cross that
    // gap, as desktop menus do, instead of making the target disappear.
    closeSubmenuTimer.current = setTimeout(() => {
      closeSubmenuTimer.current = null
      setOpen(null)
    }, 250)
  }
  useEffect(() => () => cancelSubmenuClose(), [])
  useLayoutEffect(() => {
    // A submenu that would run off the right edge opens to the left.
    const el = ref.current
    if (!el || level === 0) return
    const box = el.getBoundingClientRect()
    if (box.right > window.innerWidth - 4) setFlip(true)
  }, [level])
  useEffect(() => { if (level > 0) items(ref.current)[0]?.focus() }, [level])
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (composing(e)) return
    const list = items(ref.current)
    // Anywhere along a strip is the strip's place in the list.
    const active = document.activeElement as HTMLElement | null
    const strip = active?.parentElement?.getAttribute('role') === 'group' ? active.parentElement : null
    const at = list.indexOf((strip?.firstElementChild ?? active) as HTMLButtonElement)
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); list[step(at, list.length, e.key === 'ArrowDown')]?.focus() }
    else if (e.key === 'ArrowLeft' && onBack) { e.preventDefault(); e.stopPropagation(); onBack() }
  }
  return (
    <ul ref={ref} role="menu" aria-label={label} tabIndex={-1} className={`row-menu-list${level ? ' sub' : ''}${flip ? ' flip' : ''}`} onKeyDown={onKeyDown}
      onFocusCapture={(e) => { focused.current = e.target as HTMLElement }}
      onBlurCapture={(e) => {
        const next = e.relatedTarget as Node | null
        if (next ? !e.currentTarget.contains(next) : (e.target as HTMLElement).isConnected) focused.current = null
      }}>
      {entries.map((entry, i) => {
        const key = keys[i]
        if (entry.kind === 'sep') return <li key={key} role="separator" className="row-menu-sep" />
        if (entry.kind === 'head') return <li key={key} role="presentation" className="row-menu-head">{entry.label}</li>
        if (entry.kind === 'strip') {
          return (
            <li key={key} role="none" className="row-menu-strip">
              <div role="group" aria-label={entry.label} onKeyDown={walkStrip}>
                {entry.items.map((it) => (
                  <button key={it.data ?? it.label} type="button" role="menuitem" aria-label={it.label} title={it.label} data-row-menu={it.data}
                    onClick={() => { onClose(); it.onSelect() }}>
                    {it.icon ? <Icon name={it.icon} size={17} /> : it.text}
                  </button>
                ))}
              </div>
            </li>
          )
        }
        const sub = entry.submenu && entry.submenu.length > 0
        return (
          <li key={key} role="none" onMouseEnter={() => { cancelSubmenuClose(); setOpen(sub ? key : null) }} onMouseLeave={() => { if (sub) delaySubmenuClose() }}>
            <button
              type="button"
              role={entry.checked !== undefined ? 'menuitemradio' : 'menuitem'}
              aria-checked={entry.checked !== undefined ? entry.checked : undefined}
              aria-haspopup={sub ? 'menu' : undefined}
              aria-expanded={sub ? open === key : undefined}
              className={`${entry.danger ? 'danger' : ''}${entry.checked ? ' checked' : ''}`}
              disabled={entry.disabled}
              data-row-menu={entry.data}
              onClick={() => {
                if (sub) { setOpen(open === key ? null : key); return }
                onClose()
                entry.onSelect?.()
              }}
              onKeyDown={(e) => { if (sub && (e.key === 'ArrowRight' || enterKey(e) || e.key === ' ')) { e.preventDefault(); e.stopPropagation(); setOpen(key) } }}
            >
              <span className="row-menu-mark" aria-hidden="true">
                {entry.checked ? <Icon name="check" size={14} /> : entry.icon ? <Icon name={entry.icon} size={14} /> : null}
              </span>
              <span className="row-menu-label">{entry.label}</span>
              {entry.hint && <span className="row-menu-hint">{entry.hint}</span>}
              {sub && <span className="row-menu-more" aria-hidden="true"><Icon name="chevron-right" size={13} /></span>}
            </button>
            {sub && open === key && (
              <List entries={entry.submenu!} onClose={onClose} level={level + 1}
                onBack={() => { setOpen(null); (ref.current?.children[i]?.querySelector('button') as HTMLButtonElement | null)?.focus() }} />
            )}
          </li>
        )
      })}
    </ul>
  )
}

export const RowMenu: React.FC<Props> = ({ at, entries, label, anchor, onClose }) => {
  const ref = useRef<HTMLDivElement>(null)
  const [place, setPlace] = useState<{ left: number; top: number }>({ left: at.x, top: at.y })
  // Kept on screen: a menu opened near the bottom or the right edge moves in.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    setPlace(keepOnScreen(at, el.getBoundingClientRect(), { width: window.innerWidth, height: window.innerHeight }))
  }, [at.x, at.y])
  // Shut, it hands the focus back to what had it — the message or the row
  // it was opened on — so a keyboard carries on from there. Not when what
  // was picked has taken the focus for itself (the box to edit in, a dialog).
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null
    const box = ref.current
    return () => { if (focusGoesBack(before, document.activeElement, document.body, box)) before!.focus({ preventScroll: true }) }
  }, [])
  useEffect(() => {
    items(ref.current?.querySelector('ul') as HTMLElement | null)[0]?.focus({ preventScroll: true })
    const away = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) onClose() }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape' && !composing(e)) { e.preventDefault(); onClose() } }
    const gone = () => onClose()
    // Only scrolling the surface that owns the anchor moves this menu away
    // from its row. A conversation's auto-scroll must not close a sidebar menu.
    const scrolled = (e: Event) => {
      const target = e.target
      if (target instanceof Node && ref.current?.contains(target)) return
      if (!anchor || target === document || (target instanceof Element && target.contains(anchor))) onClose()
    }
    document.addEventListener('mousedown', away, true)
    document.addEventListener('keydown', key)
    window.addEventListener('blur', gone)
    window.addEventListener('resize', gone)
    document.addEventListener('scroll', scrolled, true)
    return () => {
      document.removeEventListener('mousedown', away, true)
      document.removeEventListener('keydown', key)
      window.removeEventListener('blur', gone)
      window.removeEventListener('resize', gone)
      document.removeEventListener('scroll', scrolled, true)
    }
  }, [onClose, anchor])
  return (
    <div ref={ref} className="row-menu" style={place} onContextMenu={(e) => e.preventDefault()}>
      {/* The name goes on the menu itself: on a plain box a screen reader says nothing of it. */}
      <List entries={entries} onClose={onClose} level={0} label={label} />
    </div>
  )
}
