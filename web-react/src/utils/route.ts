import { useCallback, useEffect, useState } from 'react'
import { isOrgId, parseAppLink, webHashFor } from '@honmaru/core/links'

// Where you are, in the URL. The app used to keep this in React state, so a
// reload landed on the feed, a notification could not open its card in a
// second tab, the browser's back button did nothing, and there was no link
// to paste to a teammate. A hash route is enough: it needs no server
// rewrite, survives a static host, and the OAuth callback uses the query
// string, which this never touches.
//
//   #/feed            the cards, whichever is first
//   #/feed/<cardId>[/<orgId>]   this card — in that workspace, switched to
//   #/list            the same cards as a list
//   #/m/<messageId>[/<orgId>]   one message in the list, for whoever can read
//                     it — in the workspace it was said in, switched to
//   #/jam/<view>      a conversation's Jam, joined — what the phone app opens
//   #/c/<view>[?org=<orgId>]  a conversation, opened in the list — `ag:<id>` is one
//                     with an agent; in that workspace, switched to, when it is yours
//
// A link from outside is a real path — https://app.honmaruai.com/c/<view>?org=…
// or /join/<code> (packages/core/src/links.ts) — so the phone apps can claim
// it; `pathToHash` turns it into its hash here, once, on load.
//   #/history … #/tools … #/you … #/team … #/insights … #/plans … #/notifications
//   #/automations     what your AI does on a schedule
//   #/playbook        the rules it follows
//   #/agents          the team's own agents: @hayao and the rest
//   #/harness #/apps #/workflows #/approvals #/skills #/agent-team
//                     the harness (docs/kylon-gap-plan.md)
//   #/join/<code>     an invitation: sign up into the team, or join it

export type Screen = 'tools' | 'history' | 'notifications' | 'plans' | 'profile' | 'team' | 'insights' | 'automations' | 'playbook' | 'agents'
  // The harness (docs/kylon-gap-plan.md): shown only in a harness workspace.
  | 'home' | 'harness' | 'apps' | 'workflows' | 'approvals' | 'skills' | 'hxagents' | 'gateways'
export type Mode = 'cards' | 'classic'

export interface Route {
  appSource?: boolean
  appConversation?: {tableId?:string;rowId?:string}
  appId?: string | null
  appOrg?: string | null
  screen: Screen | null
  /// Null when the hash names no mode (the root), so the caller can fall
  /// back to the remembered one.
  mode: Mode | null
  cardId: string | null
  /// The workspace that card is in, when the address says (a notification's).
  cardOrg?: string | null
  /// An invite code carried by the URL — the link a teammate was sent.
  join: string | null
  /// A message, from "Copy link": the list finds where it is for you.
  messageId?: string | null
  /// The workspace that message is in, when the link says.
  messageOrg?: string | null
  /// A conversation (as this person names it) whose Jam to join.
  jamView?: string | null
  /// A conversation (as this person names it) to open in the list.
  openView?: string | null
  /// The workspace that conversation is in, when the link says.
  openOrg?: string | null
}

const SCREEN_BY_PATH: Record<string, Screen> = {
  tools: 'tools', history: 'history', notifications: 'notifications',
  plans: 'plans', you: 'profile', team: 'team', insights: 'insights',
  automations: 'automations', playbook: 'playbook', agents: 'agents',
  gateways: 'gateways', home: 'home', harness: 'harness', apps: 'apps', workflows: 'workflows', approvals: 'approvals', skills: 'skills', 'agent-team': 'hxagents',
}
const PATH_BY_SCREEN: Record<Screen, string> = {
  tools: 'tools', history: 'history', notifications: 'notifications',
  plans: 'plans', profile: 'you', team: 'team', insights: 'insights',
  automations: 'automations', playbook: 'playbook', agents: 'agents',
  gateways: 'gateways', home: 'home', harness: 'harness', apps: 'apps', workflows: 'workflows', approvals: 'approvals', skills: 'skills', hxagents: 'agent-team',
}

export function parseRoute(hash: string): Route {
  const path = (hash || '').replace(/^#\/?/, '')
  const [head, ...rest] = path.split('/').filter(Boolean)
  if (!head) return { screen: null, mode: null, cardId: null, join: null }
  if (head === 'feed') {
    let cardId: string | null = null
    if (rest[0]) { try { cardId = decodeURIComponent(rest[0]) } catch { cardId = rest[0] } }
    let org = rest[1] || ''
    try { org = decodeURIComponent(org) } catch { /* as written */ }
    return { screen: null, mode: 'cards', cardId, join: null, ...(cardId && org && isOrgId(org) ? { cardOrg: org } : {}) }
  }
  if (head === 'list') return { screen: null, mode: 'classic', cardId: null, join: null }
  if (head === 'm') {
    let id = rest[0] || ''
    try { id = decodeURIComponent(id) } catch { /* as written */ }
    let org = rest[1] || ''
    try { org = decodeURIComponent(org) } catch { /* as written */ }
    const messageId = /^[\w-]{1,80}$/.test(id) ? id : null
    return { screen: null, mode: 'classic', cardId: null, join: null, messageId, messageOrg: messageId && isOrgId(org) ? org : null }
  }
  if (head === 'jam') {
    let view = rest.join('/')
    try { view = decodeURIComponent(view) } catch { /* as written */ }
    return { screen: null, mode: 'classic', cardId: null, join: null, jamView: /^(b|dm|g):[^\s]{1,200}$/.test(view) ? view : null }
  }
  if (head === 'c') {
    const [raw, query = ''] = rest.join('/').split('?')
    let view = raw
    try { view = decodeURIComponent(view) } catch { /* as written */ }
    const openView = /^(b|dm|g|ag):[^\s]{1,200}$/.test(view) ? view : null
    const org = new URLSearchParams(query).get('org')
    return { screen: null, mode: 'classic', cardId: null, join: null, openView, openOrg: openView && org && isOrgId(org) ? org : null }
  }
  if (head === 'apps' && rest.length) {
    const decode = (value: string) => { try { return decodeURIComponent(value) } catch { return '' } }
    const [appPath,query='']=rest.join('/').split('?'); const segments=appPath.split('/'); const params=new URLSearchParams(query);
    const id = decode(segments[0]), org = decode(segments[1] || '')
    const tableId=params.get('table')||'',rowId=params.get('row')||''
    const conversation=params.get('chat')==='1'&&((!tableId&&!rowId)||(/^[\w-]{1,100}$/.test(tableId)&&/^[\w-]{1,100}$/.test(rowId)))?{appConversation:rowId?{tableId,rowId}:{}}:{}
    if(params.get('source')==='1' && /^[\w-]{1,80}$/.test(id) && isOrgId(org)) return {screen:null,mode:'classic',cardId:null,join:null,appId:id,appOrg:org,appSource:true}
    return { screen: 'apps', mode: null, cardId: null, join: null, appId: /^[\w-]{1,80}$/.test(id) ? id : null, appOrg: isOrgId(org) ? org : null, ...conversation }
  }
  if (head === 'join') {
    const code = (rest[0] || '').trim()
    return { screen: null, mode: null, cardId: null, join: /^[0-9a-f]{16,64}$/i.test(code) ? code.toLowerCase() : null }
  }
  // Own keys only: `#/constructor` is not a screen.
  const screen = Object.prototype.hasOwnProperty.call(SCREEN_BY_PATH, head) ? SCREEN_BY_PATH[head] : undefined
  return screen ? { screen, mode: null, cardId: null, join: null } : { screen: null, mode: null, cardId: null, join: null }
}

export function hashForApp(id: string, orgId: string, conversation?: {tableId?:string;rowId?:string}): string { const query=new URLSearchParams();if(conversation){query.set('chat','1');if(conversation.tableId&&conversation.rowId){query.set('table',conversation.tableId);query.set('row',conversation.rowId)}}return `#/apps/${encodeURIComponent(id)}/${encodeURIComponent(orgId)}${query.size?'?'+query:''}` }
export function hashForAppSource(id:string,orgId:string):string { return `${hashForApp(id,orgId)}?source=1` }

export function hashForScreen(screen: Screen): string { return `#/${PATH_BY_SCREEN[screen]}` }
export function hashForCard(cardId: string, orgId?: string | null): string {
  return `#/feed/${encodeURIComponent(cardId)}${orgId ? `/${encodeURIComponent(orgId)}` : ''}`
}
export function hashForMode(mode: Mode): string { return mode === 'classic' ? '#/list' : '#/feed' }
/// A conversation, opened in the list: `#/c/ag%3A<id>` for one with an agent.
export function hashForView(view: string): string { return `#/c/${encodeURIComponent(view)}` }
/// A link's path (`/c/…?org=…`, `/join/…`) as the hash it means here, or
/// null when the path is not a link — the root, `/index.html`, anything else.
export function pathToHash(pathAndQuery: string): string | null {
  const link = parseAppLink(pathAndQuery)
  return link ? webHashFor(link) : null
}
export function hashForJoin(code: string): string { return `#/join/${encodeURIComponent(code)}` }
/// A message, to paste anywhere: opens where it is, in its workspace.
export function hashForMessage(messageId: string, orgId?: string | null): string {
  return `#/m/${encodeURIComponent(messageId)}${orgId ? `/${encodeURIComponent(orgId)}` : ''}`
}

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

/// At least this wide, by the same line the stylesheet draws, and kept
/// current as the window changes.
export function useMinWidth(px: number): boolean {
  const query = `(min-width: ${px}px)`
  const [wide, setWide] = useState(() => typeof matchMedia !== 'undefined' && matchMedia(query).matches)
  useEffect(() => {
    if (typeof matchMedia === 'undefined') return
    const mq = matchMedia(query)
    const onChange = () => setWide(mq.matches)
    onChange()
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [query])
  return wide
}

/// A laptop: the workbench — the inbox beside the card — begins at 1024px.
/// (The rail and the queue begin at 720px, and need JavaScript only where
/// the rail's avatar opens your status instead of the You screen.)
export function useDesktop(): boolean {
  return useMinWidth(1024)
}
