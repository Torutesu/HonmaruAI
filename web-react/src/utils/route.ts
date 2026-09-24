import { useCallback, useEffect, useState } from 'react'

// Where you are, in the URL. The app used to keep this in React state, so a
// reload landed on the feed, a notification could not open its card in a
// second tab, the browser's back button did nothing, and there was no link
// to paste to a teammate. A hash route is enough: it needs no server
// rewrite, survives a static host, and the OAuth callback uses the query
// string, which this never touches.
//
//   #/feed            the cards, whichever is first
//   #/feed/<cardId>   this card
//   #/list            the same cards as a list
//   #/history … #/tools … #/you … #/team … #/insights … #/plans … #/notifications
//   #/automations     what your AI does on a schedule
//   #/playbook        the rules it follows
//   #/join/<code>     an invitation: sign up into the team, or join it

export type Screen = 'tools' | 'history' | 'notifications' | 'plans' | 'profile' | 'team' | 'insights' | 'automations' | 'playbook'
export type Mode = 'cards' | 'classic'

export interface Route {
  screen: Screen | null
  /// Null when the hash names no mode (the root), so the caller can fall
  /// back to the remembered one.
  mode: Mode | null
  cardId: string | null
  /// An invite code carried by the URL — the link a teammate was sent.
  join: string | null
}

const SCREEN_BY_PATH: Record<string, Screen> = {
  tools: 'tools', history: 'history', notifications: 'notifications',
  plans: 'plans', you: 'profile', team: 'team', insights: 'insights',
  automations: 'automations', playbook: 'playbook',
}
const PATH_BY_SCREEN: Record<Screen, string> = {
  tools: 'tools', history: 'history', notifications: 'notifications',
  plans: 'plans', profile: 'you', team: 'team', insights: 'insights',
  automations: 'automations', playbook: 'playbook',
}

export function parseRoute(hash: string): Route {
  const path = (hash || '').replace(/^#\/?/, '')
  const [head, ...rest] = path.split('/').filter(Boolean)
  if (!head) return { screen: null, mode: null, cardId: null, join: null }
  if (head === 'feed') {
    let cardId: string | null = null
    if (rest[0]) { try { cardId = decodeURIComponent(rest[0]) } catch { cardId = rest[0] } }
    return { screen: null, mode: 'cards', cardId, join: null }
  }
  if (head === 'list') return { screen: null, mode: 'classic', cardId: null, join: null }
  if (head === 'join') {
    const code = (rest[0] || '').trim()
    return { screen: null, mode: null, cardId: null, join: /^[0-9a-f]{16,64}$/i.test(code) ? code.toLowerCase() : null }
  }
  // Own keys only: `#/constructor` is not a screen.
  const screen = Object.prototype.hasOwnProperty.call(SCREEN_BY_PATH, head) ? SCREEN_BY_PATH[head] : undefined
  return screen ? { screen, mode: null, cardId: null, join: null } : { screen: null, mode: null, cardId: null, join: null }
}

export function hashForScreen(screen: Screen): string { return `#/${PATH_BY_SCREEN[screen]}` }
export function hashForCard(cardId: string): string { return `#/feed/${encodeURIComponent(cardId)}` }
export function hashForMode(mode: Mode): string { return mode === 'classic' ? '#/list' : '#/feed' }
export function hashForJoin(code: string): string { return `#/join/${encodeURIComponent(code)}` }

function currentHash(): string {
  return typeof location !== 'undefined' ? location.hash : ''
}

/// The route, and a way to go somewhere. `replace` rewrites the current
/// entry instead of adding one — for corrections the person did not make,
/// like turning a legacy `?card=` link into its hash.
export function useRoute(): { route: Route; navigate: (hash: string, replace?: boolean) => void } {
  const [hash, setHash] = useState(currentHash)
  useEffect(() => {
    const onChange = () => setHash(currentHash())
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])
  const navigate = useCallback((next: string, replace = false) => {
    if (next === currentHash()) return
    if (replace) {
      history.replaceState(null, '', next)
      setHash(next)
    } else {
      location.hash = next
    }
  }, [])
  return { route: parseRoute(hash), navigate }
}

/// A laptop, by the same line the stylesheet draws: the workbench — the
/// inbox beside the card — begins at 1024px. (The rail and the queue begin
/// at 720px; they need no JavaScript.)
export function useDesktop(): boolean {
  const query = '(min-width: 1024px)'
  const [wide, setWide] = useState(() => typeof matchMedia !== 'undefined' && matchMedia(query).matches)
  useEffect(() => {
    if (typeof matchMedia === 'undefined') return
    const mq = matchMedia(query)
    const onChange = () => setWide(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return wide
}
