import React, { useEffect, useMemo, useState } from 'react'
import { insertMention, matchMembers, mentionQuery } from '../utils/mentions'
import type { Mentionable } from '../utils/mentions'

/// Type "@" in a box and the team's names appear under it; arrows pick,
/// Enter or Tab takes one, Escape closes. One hook, so the composer and the
/// thread offer names the same way.
export function useMentionMenu(
  box: React.RefObject<HTMLTextAreaElement | HTMLInputElement | null>,
  text: string,
  setText: (next: string) => void,
  members: Mentionable[],
) {
  const [caret, setCaret] = useState(0)
  const [index, setIndex] = useState(0)
  const [dismissed, setDismissed] = useState<string | null>(null)

  const query = useMemo(() => mentionQuery(text, caret), [text, caret])
  const options = useMemo(() => (query ? matchMembers(members, query.query) : []), [members, query])
  const open = Boolean(query) && options.length > 0 && dismissed !== `${query?.start}:${query?.query}`

  useEffect(() => { setIndex(0) }, [query?.query, query?.start])

  const track = () => {
    const el = box.current
    if (el) setCaret(el.selectionStart ?? el.value.length)
  }
  const pick = (member: Mentionable) => {
    const el = box.current
    const at = el ? (el.selectionStart ?? text.length) : caret
    const next = insertMention(text, at, member)
    setText(next.text)
    setDismissed(null)
    requestAnimationFrame(() => {
      const target = box.current
      if (!target) return
      target.focus()
      target.setSelectionRange(next.caret, next.caret)
      setCaret(next.caret)
    })
  }

  /// Returns true when the key was the menu's to take.
  const onKeyDown = (e: React.KeyboardEvent): boolean => {
    if (!open) return false
    if (e.key === 'ArrowDown') { e.preventDefault(); setIndex((i) => (i + 1) % options.length); return true }
    if (e.key === 'ArrowUp') { e.preventDefault(); setIndex((i) => (i - 1 + options.length) % options.length); return true }
    if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pick(options[index]); return true }
    if (e.key === 'Escape') { e.preventDefault(); setDismissed(`${query?.start}:${query?.query}`); return true }
    return false
  }

  const menu = open ? (
    <ul className="mention-menu" role="listbox" aria-label="Teammates">
      {options.map((m, i) => (
        <li key={m.ref} role="option" aria-selected={i === index}>
          <button
            type="button"
            className={`mention-option${i === index ? ' on' : ''}`}
            onMouseDown={(e) => { e.preventDefault(); pick(m) }}
            onMouseEnter={() => setIndex(i)}
          >
            <span className="mention-avatar" aria-hidden="true">{m.name.charAt(0).toUpperCase()}</span>
            <span className="mention-name">{m.name}</span>
          </button>
        </li>
      ))}
    </ul>
  ) : null

  return { menu, onKeyDown, track, open }
}
