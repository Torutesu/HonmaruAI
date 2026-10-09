import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { insertMention, matchMembers, mentionQuery, mentionSegments } from '../utils/mentions'
import type { Mentionable } from '../utils/mentions'
import { useCustomEmoji, type CustomEmoji } from '../utils/customEmoji'
import { bestName, rememberEmoji, searchEmoji, useEmojiData } from '../utils/emojiSearch'
import type { EmojiEntry } from '../utils/emojiData'
import { t } from '../utils/i18n'
import { composing, enterKey } from '../utils/keys'

/// ":sho" before the caret, after a space or at the start: the emoji whose
/// names hold "sho". Two letters first, as Slack waits for, so a colon in a
/// sentence opens nothing.
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

/// One line of the ':' menu: a workspace's own emoji, or a Unicode one
/// under the name of it that matched.
export type EmojiChoice = { kind: 'custom'; name: string; url: string } | { kind: 'unicode'; name: string; e: string }

/// What the ':' menu offers: the workspace's own that match, first as they
/// always were, then — once the list has loaded — the Unicode ones.
export function emojiChoices(custom: CustomEmoji[], data: EmojiEntry[] | null, query: string, max = 10): EmojiChoice[] {
  const own = matchEmoji(custom, query).map((c): EmojiChoice => ({ kind: 'custom', name: c.name, url: c.url }))
  const plain = searchEmoji(data || [], query, max).map((x): EmojiChoice => ({ kind: 'unicode', name: bestName(x, query), e: x.e }))
  return [...own, ...plain].slice(0, max)
}

/// What a choice puts in the box: a workspace's `:name:`, which only this
/// workspace draws, or the character itself.
export function emojiInsert(choice: EmojiChoice): string {
  return choice.kind === 'custom' ? `:${choice.name}:` : choice.e
}

/// ":fire:" just before the caret, after a space or at the start: a
/// shortcode written out to its closing colon, where the menu's query ends.
export function closedShortcode(text: string, caret: number): { start: number; name: string } | null {
  const m = /(^|[\s(（「])(:([a-z0-9_+-]{1,30}):)$/.exec(text.slice(0, caret))
  return m ? { start: caret - m[2].length, name: m[3] } : null
}

/// True when `text` is `prev` with one ':' typed just before the caret.
export function typedColon(prev: string, text: string, caret: number): boolean {
  return text.length === prev.length + 1 && text[caret - 1] === ':' && text.slice(0, caret - 1) + text.slice(caret) === prev
}

/// What the box holds once a shortcode written out in full is its character:
/// `:joy:` before the caret becomes 😂, as taking it from the menu a letter
/// earlier would have made it — sent as it stood, everyone read the text
/// ":joy:". Null when there is nothing to change: no emoji goes by exactly
/// that name, the workspace has its own by it (that one is drawn from its
/// `:name:`), the list is not here, or it is inside `code`.
export function completeShortcode(text: string, caret: number, custom: CustomEmoji[], data: EmojiEntry[] | null): { text: string; caret: number; e: string } | null {
  const hit = closedShortcode(text, caret)
  if (!hit || !data || custom.some((c) => c.name === hit.name)) return null
  if ((text.slice(0, hit.start).split('`').length - 1) % 2) return null
  const e = data.find((x) => x.n.includes(hit.name))?.e
  return e ? { text: text.slice(0, hit.start) + e + text.slice(caret), caret: hit.start + e.length, e } : null
}

/// Type "@" in a box and the team's names appear under it; ":" and two
/// letters, and the emoji by those names — the workspace's own first. Arrows
/// pick, Enter or Tab takes one, Escape closes; a name typed all the way to
/// its second colon is taken too. One hook, so the composer and the thread
/// offer them the same way.
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
  const closed = useMemo(() => (people || emoji ? null : closedShortcode(text, caret)), [people, emoji, text, caret])
  // The list is fetched the first time a ':' query is typed, not before.
  const unicode = useEmojiData(Boolean(emoji || closed))
  const emojiOptions = useMemo(() => (emoji ? emojiChoices(custom, unicode, emoji.query) : []), [custom, unicode, emoji])
  const query = people || emoji
  const count = people ? peopleOptions.length : emojiOptions.length
  const open = Boolean(query) && count > 0 && dismissed !== `${query?.start}:${query?.query}`

  useEffect(() => { setIndex(0) }, [query?.query, query?.start])

  // Only a caret that moved is set: track runs on every key's release and
  // every click too, and a set to the same place still re-ran the whole
  // conversation around the box before React found nothing had changed.
  const caretNow = useRef(caret)
  caretNow.current = caret
  const track = () => {
    const el = box.current
    if (!el) return
    const at = el.selectionStart ?? el.value.length
    if (at === caretNow.current) return
    caretNow.current = at
    setCaret(at)
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
    const next = insertMention(text, at, member, members)
    pendingCaret.current = next.caret
    setText(next.text)
    setDismissed(null)
  }
  const pickEmoji = (choice: EmojiChoice) => {
    if (!emoji) return
    const el = box.current
    const at = el ? (el.selectionStart ?? text.length) : caret
    const insert = `${emojiInsert(choice)} `
    pendingCaret.current = emoji.start + insert.length
    setText(text.slice(0, emoji.start) + insert + text.slice(at))
    setDismissed(null)
    rememberEmoji(emojiInsert(choice))
  }
  const take = (i: number) => { if (people) pick(peopleOptions[i]); else pickEmoji(emojiOptions[i]) }

  // A shortcode typed through to its closing colon becomes its character.
  // Only as that colon is typed (or once the list arrives, if the box has
  // not changed since): a draft put back in the box, or a caret set down
  // after a ":name:" that was pasted, is left as it was written.
  const before = useRef(text)
  const colonAt = useRef<string | null>(null)
  useEffect(() => {
    const prev = before.current
    before.current = text
    if (prev !== text) colonAt.current = typedColon(prev, text, caret) ? text : null
    if (colonAt.current !== text) return
    const done = completeShortcode(text, caret, custom, unicode)
    if (!done) return
    colonAt.current = null
    pendingCaret.current = done.caret
    setText(done.text)
    rememberEmoji(done.e)
  // setText is the caller's and new with every render of it.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, caret, custom, unicode])

  /// Returns true when the key was the menu's to take.
  const onKeyDown = (e: React.KeyboardEvent): boolean => {
    if (!open || composing(e)) return false
    if (e.key === 'ArrowDown') { e.preventDefault(); setIndex((i) => (i + 1) % count); return true }
    if (e.key === 'ArrowUp') { e.preventDefault(); setIndex((i) => (i - 1 + count) % count); return true }
    if (enterKey(e) || e.key === 'Tab') { e.preventDefault(); take(Math.min(index, count - 1)); return true }
    if (e.key === 'Escape' && !composing(e)) { e.preventDefault(); setDismissed(`${query?.start}:${query?.query}`); return true }
    return false
  }

  const menu = open && !people ? (
    <ul className="mention-menu emoji" role="listbox" aria-label={t('Emoji')}>
      {emojiOptions.map((e, i) => (
        <li key={e.kind === 'custom' ? `:${e.name}:` : e.e} role="option" aria-selected={i === index}>
          <button
            type="button"
            className={`mention-option${i === index ? ' on' : ''}`}
            onMouseDown={(ev) => { ev.preventDefault(); pickEmoji(e) }}
            onMouseEnter={() => setIndex(i)}
            data-emoji-option={e.kind === 'custom' ? e.name : undefined}
            data-emoji-char={e.kind === 'unicode' ? e.e : undefined}
          >
            {e.kind === 'custom'
              ? <img className="mention-emoji" src={e.url} alt="" />
              : <span className="mention-emoji uni" aria-hidden="true">{e.e}</span>}
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
            data-mention-option={m.agent ? `agent:${m.handle}` : undefined}
          >
            {m.special ? (
              <span className="mention-at" aria-hidden="true">@</span>
            ) : (
              <span className={`mention-face${m.agent || m.ref === '__ai' ? ' agent' : ''}`} aria-hidden="true">
                {m.avatarUrl ? <img src={m.avatarUrl} alt="" /> : <span className="mention-avatar">{m.agent ? (m.emoji || '🤖') : m.ref === '__ai' ? '✦' : m.name.charAt(0).toUpperCase()}</span>}
                {m.ref !== '__ai' && <span className={`mention-dot${m.agent || m.online ? ' on' : ''}`} title={m.agent || m.online ? t('Online') : t('Offline')} />}
              </span>
            )}
            <span className="mention-name" title={m.title || undefined}>{m.special ? m.handle : m.name}</span>
            {!m.special && m.handle && <span className="mention-handle">@{m.handle}</span>}
            <span className="mention-side">
              {m.special ? m.detail : m.agent ? t('Agent') : m.outside ? t('Not in channel') : ''}
            </span>
          </button>
        </li>
      ))}
    </ul>
  ) : null

  return { menu, onKeyDown, track, open }
}


/// Colour for the @names in a box as they are typed: a layer under the
/// textarea draws the same text, with every @name that reaches somebody
/// marked, and the textarea's own letters go transparent over it. An @word
/// that names nobody stays plain — the difference is the point. The layer
/// copies the box's place and size, and scrolls with it; it changes no
/// metrics (no weight, no padding), so the letters line up.
///
/// `layout` is whatever sits above the box in its composer — a "Replying
/// to" bar, files waiting to go — as one value: when it changes the box
/// has moved without its text or its size changing, and the layer is put
/// where the box now is before the screen is drawn.
export function useMentionHighlight(
  box: React.RefObject<HTMLTextAreaElement | null>,
  text: string,
  members: Mentionable[],
  layout: string | number | boolean | null = null,
): { layer: React.ReactNode; active: boolean } {
  const parts = useMemo(() => mentionSegments(text, members), [text, members])
  const active = parts.some((p) => p.mention && p.kind)
  const layerRef = useRef<HTMLDivElement>(null)
  const [place, setPlace] = useState<React.CSSProperties | null>(null)
  useLayoutEffect(() => {
    const el = box.current
    if (!el || !active) return
    const sync = () => {
      // Once the box is at its tallest it scrolls, and its scrollbar takes
      // width from the letters; the layer has none, so without the same room
      // on its right it wrapped the lines later and the caret drifted off the
      // words it sat in.
      const cs = getComputedStyle(el)
      const bar = el.offsetWidth - el.clientWidth - (parseFloat(cs.borderLeftWidth) || 0) - (parseFloat(cs.borderRightWidth) || 0)
      const paddingRight = (parseFloat(cs.paddingRight) || 0) + Math.max(0, bar)
      setPlace((prev) => {
        const next = { top: el.offsetTop, left: el.offsetLeft, width: el.offsetWidth, height: el.offsetHeight, paddingRight }
        return prev && prev.top === next.top && prev.left === next.left && prev.width === next.width && prev.height === next.height && prev.paddingRight === next.paddingRight ? prev : next
      })
      if (layerRef.current) layerRef.current.scrollTop = el.scrollTop
    }
    sync()
    el.addEventListener('scroll', sync)
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(sync) : null
    ro?.observe(el)
    // The composer the box is placed in, too: anything else that comes or
    // goes inside it (a picture's preview loading, say) moves the box, and
    // changes the composer's size when it does.
    if (el.offsetParent) ro?.observe(el.offsetParent)
    return () => { el.removeEventListener('scroll', sync); ro?.disconnect() }
  }, [box, active, text, layout])
  // A new place (the room for the scrollbar above) re-lays the layer out
  // after sync set its scroll, which could not reach that far yet.
  useLayoutEffect(() => {
    if (layerRef.current && box.current) layerRef.current.scrollTop = box.current.scrollTop
  }, [box, place])
  const layer = active && place ? (
    <div ref={layerRef} className={`${box.current?.className.replace(/\bhas-mentions\b/, '') || ''} mention-layer`} style={place} aria-hidden="true">
      {parts.map((p, i) => (p.mention && p.kind
        ? <mark key={i} className={`mention-hl m-${p.kind}`}>{p.text}</mark>
        : <React.Fragment key={i}>{p.text}</React.Fragment>))}
      {/* A trailing newline needs a line to sit on, as it has in the box. */}
      {text.endsWith('\n') ? ' ' : null}
    </div>
  ) : null
  return { layer, active }
}
