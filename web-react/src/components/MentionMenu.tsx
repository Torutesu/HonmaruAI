import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { insertMention, matchMembers, mentionQuery } from '../utils/mentions'
import type { Mentionable } from '../utils/mentions'
import { useCustomEmoji, type CustomEmoji } from '../utils/customEmoji'
import { t } from '../utils/i18n'

/// ":sho" before the caret, after a space or at the start: the workspace's
/// emoji whose names hold "sho". Two letters first, as Slack waits for, so
/// a colon in a sentence opens nothing.
export function emojiQuery(text: string, caret: number): { start: number; query: string } | null {
  const m = /(^|[\s(（「])(:([a-z0-9_+-]{2,30}))$/.exec(text.slice(0, caret))
  return m ? { start: caret - m[2].length, query: m[3] } : null
}

export function matchEmoji(list: CustomEmoji[], query: string): CustomEmoji[] {
  return list
    .filter((e) => e.name.includes(query))
    .sort((a, b) => Number(!a.name.startsWith(query)) - Number(!b.name.startsWith(query)) || a.name.localeCompare(b.name))
    .slice(0, 8)
}

/// Type "@" in a box and the team's names appear under it; ":" and two
/// letters, and the workspace's own emoji. Arrows pick, Enter or Tab takes
/// one, Escape closes. One hook, so the composer and the thread offer them
/// the same way.
export function useMentionMenu(
  box: React.RefObject<HTMLTextAreaElement | HTMLInputElement | null>,
  text: string,
  setText: (next: string) => void,
  members: Mentionable[],
) {
  const [caret, setCaret] = useState(0)
  const [index, setIndex] = useState(0)
  const [dismissed, setDismissed] = useState<string | null>(null)

  const custom = useCustomEmoji()
  const people = useMemo(() => mentionQuery(text, caret), [text, caret])
  const peopleOptions = useMemo(() => (people ? matchMembers(members, people.query) : []), [members, people])
  const emoji = useMemo(() => (people ? null : emojiQuery(text, caret)), [people, text, caret])
  const emojiOptions = useMemo(() => (emoji ? matchEmoji(custom, emoji.query) : []), [custom, emoji])
  const query = people || emoji
  const count = people ? peopleOptions.length : emojiOptions.length
  const open = Boolean(query) && count > 0 && dismissed !== `${query?.start}:${query?.query}`

  useEffect(() => { setIndex(0) }, [query?.query, query?.start])

  const track = () => {
    const el = box.current
    if (el) setCaret(el.selectionStart ?? el.value.length)
  }
  // Where the caret goes once the picked name is in the box. Placed as soon
  // as the new text is on screen, before any key after it: placed a frame
  // later, a fast typist's next words — or a slow machine's — were already
  // at the end, and the caret jumped back into the middle of them.
  const pendingCaret = useRef<number | null>(null)
  useLayoutEffect(() => {
    const at = pendingCaret.current
    const target = box.current
    if (at === null || !target || target.value !== text) return
    pendingCaret.current = null
    target.focus()
    target.setSelectionRange(at, at)
    setCaret(at)
  }, [text, box])
  const pick = (member: Mentionable) => {
    const el = box.current
    const at = el ? (el.selectionStart ?? text.length) : caret
    const next = insertMention(text, at, member)
    pendingCaret.current = next.caret
    setText(next.text)
    setDismissed(null)
  }
  const pickEmoji = (e: CustomEmoji) => {
    if (!emoji) return
    const el = box.current
    const at = el ? (el.selectionStart ?? text.length) : caret
    const insert = `:${e.name}: `
    pendingCaret.current = emoji.start + insert.length
    setText(text.slice(0, emoji.start) + insert + text.slice(at))
    setDismissed(null)
  }
  const take = (i: number) => { if (people) pick(peopleOptions[i]); else pickEmoji(emojiOptions[i]) }

  /// Returns true when the key was the menu's to take.
  const onKeyDown = (e: React.KeyboardEvent): boolean => {
    if (!open) return false
    if (e.key === 'ArrowDown') { e.preventDefault(); setIndex((i) => (i + 1) % count); return true }
    if (e.key === 'ArrowUp') { e.preventDefault(); setIndex((i) => (i - 1 + count) % count); return true }
    if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); take(Math.min(index, count - 1)); return true }
    if (e.key === 'Escape') { e.preventDefault(); setDismissed(`${query?.start}:${query?.query}`); return true }
    return false
  }

  const menu = open && !people ? (
    <ul className="mention-menu emoji" role="listbox" aria-label={t('Emoji')}>
      {emojiOptions.map((e, i) => (
        <li key={e.name} role="option" aria-selected={i === index}>
          <button
            type="button"
            className={`mention-option${i === index ? ' on' : ''}`}
            onMouseDown={(ev) => { ev.preventDefault(); pickEmoji(e) }}
            onMouseEnter={() => setIndex(i)}
            data-emoji-option={e.name}
          >
            <img className="mention-emoji" src={e.url} alt="" />
            <span className="mention-name">:{e.name}:</span>
          </button>
        </li>
      ))}
    </ul>
  ) : open ? (
    <ul className="mention-menu" role="listbox" aria-label={t('Teammates')}>
      {peopleOptions.map((m, i) => (
        <li key={m.ref} role="option" aria-selected={i === index}>
          <button
            type="button"
            className={`mention-option${i === index ? ' on' : ''}`}
            onMouseDown={(e) => { e.preventDefault(); pick(m) }}
            onMouseEnter={() => setIndex(i)}
          >
            <span className="mention-avatar" aria-hidden="true">{m.name.charAt(0).toUpperCase()}</span>
            <span className="mention-name">{m.name}</span>
            {m.handle && <span className="mention-handle">@{m.handle}</span>}
          </button>
        </li>
      ))}
    </ul>
  ) : null

  return { menu, onKeyDown, track, open }
}
