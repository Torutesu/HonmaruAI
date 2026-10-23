// The interface, in the language the person reads.
//
// Card *content* was already translated by the Worker and picked up through
// `card.localized[locale]`. The chrome around it never was — so choosing 日本語
// under You changed the notifications and nothing on the screen, which reads
// as a setting that does not work.
//
// The key is the English string. That keeps the call sites readable, makes a
// missing translation degrade to English rather than to a key name, and means
// adding a language is adding one column here.

import { getLocale, setLocale, primary } from './locale'
import { useSyncExternalStore, useCallback } from 'react'

type Dict = Record<string, string>


// Most keys are their own English text. A few sentences are too long to read
// well as a key, so they get a name and an entry here; `t` falls back through
// this before falling back to the key itself.
const en: Dict = {
  'room.automations': 'Automations',
  'tidy.blurb': 'Channels with no message, canvas or bookmark — most made by the AI when it filed cards. Archiving hides them from every list; their cards and history stay.',
  'archive.lede': 'It leaves everyone\'s sidebar. Its messages, files and decisions are kept, and it can be restored any time from Archived channels on your profile.',
  'record.channelHint': 'This channel’s story and decisions, written by the AI from what was said. Written again when something new is said.',
  'channels (count)': 'channels',
  'canvas.empty':
    'A shared document for this conversation: how things are done, what was decided, who owns what, what is still open. Anyone here can edit it, and your AI can draft it from the conversation.',
  'canvas.syntax': '## Heading · - list · - [ ] to-do · **bold** · {key} to save',
  'studio.apps.lede':
    'Gmail, Slack and Notion are connected by each person, with their own account. What they bring in reaches only your feed and is not shared with anyone else. GitHub is shared by the whole workspace.',
  'webhooks.lede':
    'Send this workspace’s events to your service. A webhook acts as the member who made it, and only receives events from conversations they belong to.',
  'audit.lede':
    'Who did what, when and from where — never what was said. Only admins can read it, and download it as CSV or JSONL. Every entry is numbered and chained to the one before, so a deletion or an edit shows.',
  'search.syntax':
    'from:@name in:#channel in:@name to:@name before: after: on: during: has:file has:link has:reaction has:thread has:pin is:thread is:pinned is:saved is:dm "exact words" -without',
  'compose.hint':
    'Who it is for, what they decide, and by when. Your AI writes the card and routes it.',
  'tools.lede':
    'Connected tools feed your AI. They do not put channels in here — what comes back is decisions, in the same feed as everything else.',
  'notify.language':
    'Whichever channel carries it, the words are written in your language — not the language of whoever set the decision in motion.',
  'history.blurb':
    'Decisions land here the moment they are made — yours and the ones you asked for.',
  'businesses.blurb': 'Nobody made this list. It grows as decisions are filed.',
  'ob.tell.title': 'Tell your AI. Not a channel.',
  'ob.tell.body':
    '“Ask Kenji to sign off on the new supplier price.” That is the whole interaction. There is nowhere to post it, nobody to @-mention, and no channel to pick.',
  'ob.route.title': 'It works out who decides.',
  'ob.route.body':
    'Your AI reads your team — roles, who owns what, who is drowning — and hands it to the right person’s AI, which rewrites it as a card built for their decision, not your sentence.',
  'ob.swipe.title': 'Clear it in one tap.',
  'ob.swipe.body':
    'Approve, decline, ask for a revision, or hand it to someone else. The answer goes straight back to the person who asked — and to GitHub, if it belongs there.',
  'welcome.lede':
    'You talk to your own AI. It works out who needs to decide what, and their AI puts it in front of them as a card they can clear in a swipe. No channels. No inbox. No “did you see my message?”.',
  'signin.code.lede':
    'We send a six-digit code. Nothing to remember, and it proves where your decisions should reach you.',
  'delete.body':
    'This removes your account and your cards. Decisions other people made stay in their record — those are theirs, not yours.',
  'plans.trial': 'Free for {days} days, then ${price} a month. Cancel any time.',
  'plans.trial.seat': 'Free for {days} days, then ${price} per person a month. Cancel any time.',
  'plans.notForSale':
    'Nothing is for sale on this deployment yet. Everyone gets {n} AI-routed decisions a day in the meantime.',
  'record.hint': 'Every decision, per business, as it stands now. Nobody writes this; it is what happened.',
  'crash.body':
    'This screen could not be drawn. Reloading is safe — your decisions are on the relay, not in this tab.',
  // Automations and agents: sentences too long to read well as keys.
  'automations.lede': 'Your AI does the work on a schedule and brings the result to your feed as a card — a report you can read, download or print.',
  'automations.placeholder': 'e.g. Every Monday at 9am, summarise last week’s decisions and what is stuck',
  'automations.cost': 'What each run cost is shown beside it. A report the model writes costs about as much as one answer; with no model, your AI sends a digest, and it is free.',
  'agents.blurb': 'Any agent that speaks MCP can ask a person on this team for a decision. The question arrives in their feed as a card; the agent reads the answer once it is made. The agent never decides for them.',
}




// Only the language being read is loaded: each table is its own chunk,
// fetched when the language is chosen (and before the first paint, from
// main.tsx). English is the keys themselves and always here.
const LOADERS: Record<string, () => Promise<{ default: Dict }>> = {
  ja: () => import('./locales/ja'),
  es: () => import('./locales/es'),
  fr: () => import('./locales/fr'),
  de: () => import('./locales/de'),
}
const TABLES: Record<string, Dict> = { en }
const loading = new Map<string, Promise<void>>()

/// The table for a language, fetched once. Resolves when it is ready (at
/// once for English and for a language with no table of its own).
export function loadLocale(code: string): Promise<void> {
  const lang = primary(code)
  if (TABLES[lang] || !LOADERS[lang]) return Promise.resolve()
  if (!loading.has(lang)) {
    loading.set(lang, LOADERS[lang]().then((m) => {
      TABLES[lang] = m.default
      if (lang === current) {
        // A new snapshot, or React sees the same language and skips the
        // repaint: whatever did not happen to redraw stayed in English.
        loaded += 1
        for (const fn of listeners) fn()
        if (typeof window !== 'undefined') window.dispatchEvent(new Event('honmaru:locale'))
      }
    }).catch(() => { loading.delete(lang) }))
  }
  return loading.get(lang)!
}

/// Ready for the language being read.
export function localeReady(): Promise<void> {
  return loadLocale(current)
}

let current = primary(getLocale())
// Tables that have arrived: part of the snapshot, so one arriving repaints.
let loaded = 0
const listeners = new Set<() => void>()

/// What a component using `useT` is drawn from: the language, and how many
/// tables have arrived. Exported for its test.
export function snapshot(): string {
  return `${current}:${loaded}`
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

/// Translate. The key is the English string, so an untranslated one shows in
/// English rather than as a missing-key placeholder.
export function t(key: string, vars?: Record<string, string | number>): string {
  const table = TABLES[current]
  let out = (table && table[key]) || en[key] || key
  if (vars) {
    for (const [name, value] of Object.entries(vars)) {
      out = out.replace(new RegExp(`\\{${name}\\}`, 'g'), String(value))
    }
  }
  return out
}

/// The same, from a component, so choosing a language repaints the screen
/// instead of waiting for the next unrelated render.
export function useT(): typeof t {
  useSyncExternalStore(subscribe, snapshot, snapshot)
  return useCallback(t, [])
}

/// Change it everywhere: the store the rest of the app reads, this table, and
/// the document's own lang attribute, which is what a screen reader uses.
export function changeLocale(code: string | null): void {
  setLocale(code)
  current = primary(getLocale())
  // Its table, if not here yet: the screen repaints again when it is.
  void loadLocale(current)
  if (typeof document !== 'undefined') document.documentElement.lang = current
  for (const fn of listeners) fn()
  // Screens keyed on the language redraw whole, not just their labels.
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('honmaru:locale'))
}

/// The account's language, as the Worker has it: the one choice every
/// device follows. Chosen on the phone or in another browser, it reaches
/// this one the next time it opens or comes back to the front — before, a
/// browser in English showed English beside cards written in Japanese.
/// Returns whether anything changed.
export function adoptAccountLocale(code: unknown): boolean {
  if (typeof code !== 'string' || !/^[a-z]{2,3}([-_][A-Za-z0-9]+)*$/.test(code)) return false
  if (primary(code) === primary(getLocale())) return false
  changeLocale(primary(code))
  return true
}

/// Call once at start-up so the document agrees with the stored choice.
export function applyStoredLocale(): Promise<void> {
  current = primary(getLocale())
  if (typeof document !== 'undefined') document.documentElement.lang = current
  return loadLocale(current)
}
