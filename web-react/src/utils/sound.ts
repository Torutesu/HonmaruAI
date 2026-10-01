// What the app sounds like, and when it makes a sound.
//
// A sound is how somebody who is looking elsewhere finds out that something
// needs them, so it is kept for exactly that. The rules:
//
// - Never for anything you did yourself: a message you wrote, a reaction you
//   left, a Jam you started. (Sending has its own quiet confirmation, and only
//   in a direct conversation, as Slack does it.)
// - Never for a conversation you muted; for "mentions only", only a mention.
// - A direct message or an @mention knocks; a new decision for you chimes; a
//   message in a channel is silent unless you asked for channel sounds.
// - In the conversation you are looking at, a new message is a soft tick, not
//   a knock: you are already there.
// - One tab plays. With the app open in three tabs, one sound, not three.
// - Not more than one sound a second and a half: a burst of messages is one.
//
// Everything is synthesised with Web Audio — no files to load, nothing to
// cache, the same on every browser. The voice is a felt piano: soft keys
// with a short room tail, quiet enough to hear all day. Every sound is over
// within a second except the Jam ring, which repeats until it is answered.
//
// Settings are per device (a laptop and a phone on one desk should not both
// knock), in localStorage.

import { isQuiet } from './quiet'
import { desktopApp } from './desktop'

export type SoundKind = 'mention' | 'message' | 'inConversation' | 'sent' | 'decision' | 'reply' | 'jamJoin' | 'jamLeave' | 'ring'

export interface SoundSettings {
  enabled: boolean
  volume: number // 0..1
  mentions: boolean // DMs and @mentions
  channels: boolean // every message in a channel you have not muted
  inConversation: boolean
  sent: boolean
  decisions: boolean
  replies: boolean
  calls: boolean
  jam: boolean // join and leave
}

export const DEFAULT_SOUNDS: SoundSettings = {
  enabled: true, volume: 0.4,
  mentions: true, channels: false, inConversation: false, sent: false, decisions: true, replies: true, calls: true, jam: false,
}

const KEY = 'sounds.v1'

export function loadSoundSettings(): SoundSettings {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || 'null')
    const next = { ...DEFAULT_SOUNDS }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return next
    for (const key of Object.keys(next) as Array<keyof SoundSettings>) {
      if (key === 'volume') { if (typeof raw.volume === 'number' && Number.isFinite(raw.volume)) next.volume = Math.max(0, Math.min(1, raw.volume)) }
      else if (typeof raw[key] === 'boolean') next[key] = raw[key]
    }
    // Preserve the old combined call switch for existing users.
    if (typeof raw.calls !== 'boolean' && typeof raw.jam === 'boolean') next.calls = raw.jam
    return next
  } catch { return { ...DEFAULT_SOUNDS } }
}

export function saveSoundSettings(next: SoundSettings): void {
  try { localStorage.setItem(KEY, JSON.stringify(next)) } catch { /* this device only, and not today */ }
}

/// Which setting lets a kind of sound play.
export function allowedBy(s: SoundSettings, kind: SoundKind): boolean {
  if (!s.enabled) return false
  switch (kind) {
    case 'mention': return s.mentions
    case 'message': return s.channels
    case 'inConversation': return s.inConversation
    case 'sent': return s.sent
    case 'decision': return s.decisions
    case 'reply': return s.replies
    case 'ring': return s.calls
    case 'jamJoin': case 'jamLeave': return s.jam
  }
}

// ---- One tab plays ----
//
// The tab that holds a Web Lock is the one that plays; the others stay
// quiet. When it closes the lock passes to another. Browsers without Web
// Locks play in every tab, which is the old behaviour and no worse.
let leader = typeof navigator === 'undefined' || !('locks' in navigator)
if (!leader && typeof navigator !== 'undefined') {
  try {
    void (navigator as Navigator & { locks: { request: (n: string, cb: () => Promise<void>) => Promise<void> } }).locks
      .request('honmaru-sound', () => { leader = true; return new Promise<void>(() => { /* held while the tab lives */ }) })
      .catch(() => { leader = true })
  } catch { leader = true }
}

// ---- The audio context, woken by the first touch ----
//
// A page may not make a sound before the person has touched it; the context
// is made then, and resumed on every later touch in case the browser
// suspended it.
let ctx: AudioContext | null = null
function audio(): AudioContext | null {
  if (typeof window === 'undefined') return null
  const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!AC) return null
  if (!ctx) { try { ctx = new AC() } catch { return null } }
  if (ctx.state === 'suspended') void ctx.resume().catch(() => {})
  return ctx
}
if (typeof window !== 'undefined') {
  const wake = () => { audio() }
  window.addEventListener('pointerdown', wake, { passive: true })
  window.addEventListener('keydown', wake)
}

/// A small room: a short, soft tail so a note does not stop dead. Its
/// impulse is made once per audio context; each sound gets its own room,
/// wired to its own output, so nothing stays connected after it.
let impulse: AudioBuffer | null = null
let impulseOf: AudioContext | null = null
function roomFor(ac: AudioContext, out: AudioNode): AudioNode {
  if (!impulse || impulseOf !== ac) {
    const len = Math.floor(ac.sampleRate * 0.9)
    impulse = ac.createBuffer(2, len, ac.sampleRate)
    for (let c = 0; c < 2; c++) {
      const d = impulse.getChannelData(c)
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3.2)
    }
    impulseOf = ac
  }
  const room = ac.createConvolver()
  room.buffer = impulse
  const wet = ac.createGain()
  wet.gain.value = 0.22
  room.connect(wet).connect(out)
  return room
}

/// One felt key: a soft attack, the note and its octave fading faster than
/// it, high frequencies rolled off — a piano played through felt.
function key(ac: AudioContext, out: AudioNode, room: AudioNode, { freq, at, dur, gain, lp = 1800, partials = [[1, 1], [2, 0.3, 0.6], [3, 0.1, 0.3]], wet = true }: { freq: number; at: number; dur: number; gain: number; lp?: number; partials?: number[][]; wet?: boolean }) {
  const env = ac.createGain()
  env.gain.setValueAtTime(0.0001, at)
  env.gain.exponentialRampToValueAtTime(gain, at + 0.012)
  env.gain.exponentialRampToValueAtTime(0.0001, at + dur)
  const soft = ac.createBiquadFilter()
  soft.type = 'lowpass'
  soft.frequency.value = lp
  soft.Q.value = 0.4
  env.connect(soft)
  soft.connect(out)
  if (wet) soft.connect(room)
  for (const [mult, amp, decay = 1] of partials) {
    const osc = ac.createOscillator()
    const g = ac.createGain()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(freq * mult, at)
    g.gain.setValueAtTime(amp, at)
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur * decay)
    osc.connect(g).connect(env)
    osc.start(at)
    osc.stop(at + dur + 0.05)
  }
}

const D5 = 587.33, FS5 = 739.99, A5 = 880

/// The sounds themselves: soft felt keys, all from one D major chord, so
/// any two that happen together do not clash.
function render(kind: SoundKind, ac: AudioContext, out: AudioNode) {
  const t = ac.currentTime + 0.01
  const two = [[1, 1], [2, 0.28, 0.6]]
  const room = roomFor(ac, out)
  switch (kind) {
    case 'mention': // two keys, a third apart: somebody wants you
      key(ac, out, room, { freq: FS5, at: t, dur: 0.5, gain: 0.6 })
      key(ac, out, room, { freq: A5, at: t + 0.14, dur: 0.7, gain: 0.56 })
      break
    case 'message': // one low key, barely pressed
      key(ac, out, room, { freq: D5, at: t, dur: 0.4, gain: 0.3, lp: 1600, partials: [[1, 1], [2, 0.25, 0.5]] })
      break
    case 'inConversation': // a touch of a key: you are already here
      key(ac, out, room, { freq: A5, at: t, dur: 0.12, gain: 0.14, lp: 1800, partials: [[1, 1]], wet: false })
      break
    case 'sent': // the lightest tap
      key(ac, out, room, { freq: A5, at: t, dur: 0.08, gain: 0.1, lp: 2000, partials: [[1, 1]], wet: false })
      break
    case 'decision': // the chord, rising: something is waiting on you
      key(ac, out, room, { freq: D5, at: t, dur: 0.6, gain: 0.52, lp: 1700, partials: two })
      key(ac, out, room, { freq: FS5, at: t + 0.14, dur: 0.6, gain: 0.48, lp: 1700, partials: two })
      key(ac, out, room, { freq: A5, at: t + 0.28, dur: 0.9, gain: 0.48, partials: two })
      break
    case 'reply': // falling pair: a request has an answer
      key(ac, out, room, { freq: A5, at: t, dur: 0.45, gain: 0.4, partials: two })
      key(ac, out, room, { freq: D5, at: t + 0.16, dur: 0.65, gain: 0.4, partials: two })
      break
    case 'jamJoin': // up
      key(ac, out, room, { freq: D5, at: t, dur: 0.4, gain: 0.44, partials: two })
      key(ac, out, room, { freq: A5, at: t + 0.12, dur: 0.55, gain: 0.4, partials: two })
      break
    case 'jamLeave': // down
      key(ac, out, room, { freq: A5, at: t, dur: 0.4, gain: 0.36, partials: two })
      key(ac, out, room, { freq: D5, at: t + 0.12, dur: 0.55, gain: 0.34, partials: two })
      break
    case 'ring': // one ring of a call: the mention's two keys, twice
      for (const off of [0, 0.26]) {
        key(ac, out, room, { freq: FS5, at: t + off, dur: 0.3, gain: 0.5, lp: 2200 })
        key(ac, out, room, { freq: A5, at: t + off + 0.1, dur: 0.36, gain: 0.46, lp: 2200 })
      }
      break
  }
}

let nativeLastAt = -Infinity
let nativePriority = 0
// Visual notifications still arrive during a burst; only their sound is coalesced.
export function nativeNotificationSilent(kind: SoundKind): boolean {
  const settings = loadSoundSettings()
  if (!allowedBy(settings, kind) || settings.volume === 0 || isQuiet()) return true
  const now = Date.now()
  if (now - nativeLastAt < QUIET_MS && priority(kind) <= nativePriority) return true
  nativeLastAt = now; nativePriority = priority(kind)
  return false
}

let lastAt = 0
const QUIET_MS = 1500
// Sounds that are answers to what you just did are never swallowed by the
// burst rule — you pressed send, you hear it.
const PERSONAL: SoundKind[] = ['sent', 'jamJoin', 'jamLeave']
let lastPriority = 0
const priority = (kind: SoundKind) => kind === 'ring' ? 3 : ['mention', 'decision', 'reply'].includes(kind) ? 2 : 1

/// Play a sound, if the settings, the tab and the moment allow it.
/// `preview` plays regardless — for the settings screen's ▶ buttons.
export function playSound(kind: SoundKind, { preview = false }: { preview?: boolean } = {}): boolean {
  const settings = loadSoundSettings()
  if (!preview) {
    if (!allowedBy(settings, kind) || settings.volume === 0) return false
    // Background desktop alerts use the OS sound, respecting Focus and
    // system volume. Never play Web Audio on top of that notification.
    if (desktopApp() && ['mention', 'decision', 'reply', 'message'].includes(kind) &&
      (document.visibilityState !== 'visible' || !document.hasFocus())) return false
    // Notifications paused, or outside the person's hours: no sound either,
    // except for what they did themselves (sent, joined, left).
    if (isQuiet() && !PERSONAL.includes(kind)) return false
    if (!leader && !PERSONAL.includes(kind)) return false
    const now = Date.now()
    if (!PERSONAL.includes(kind)) {
      if (now - lastAt < QUIET_MS && priority(kind) <= lastPriority) return false
    }
  }
  const ac = audio()
  if (!ac || ac.state !== 'running') return false
  if (!preview && !PERSONAL.includes(kind)) { lastAt = Date.now(); lastPriority = priority(kind) }
  const master = ac.createGain()
  master.gain.value = Math.max(0, Math.min(1, preview && settings.volume === 0 ? DEFAULT_SOUNDS.volume : settings.volume)) * 0.5
  master.connect(ac.destination)
  render(kind, ac, master)
  setTimeout(() => { try { master.disconnect() } catch { /* already gone */ } }, 2400)
  return true
}

// ---- A ring that repeats until it is answered ----

let ringTimer: ReturnType<typeof setInterval> | null = null
let ringStop: ReturnType<typeof setTimeout> | null = null
/// Ring every two seconds for up to `forMs` (30 s), or until stopRing().
export function startRing(forMs = 30_000): void {
  stopRing()
  if (!playSound('ring')) return
  ringTimer = setInterval(() => { playSound('ring') }, 2000)
  ringStop = setTimeout(stopRing, forMs)
}
export function stopRing(): void {
  if (ringTimer) clearInterval(ringTimer)
  if (ringStop) clearTimeout(ringStop)
  ringTimer = null; ringStop = null
}

// ---- What the list knows, for whoever decides on a sound ----
//
// The list holds each conversation's notification level and which one is
// open; the sound for a message arriving is decided where the socket is,
// which may be while the list is not on screen. So the list writes these
// down here, and they are kept per workspace in localStorage between pages.

let openView: string | null = null
export function setOpenView(view: string | null): void { openView = view }
export function getOpenView(): string | null { return openView }

const prefsKey = (orgId: string) => `sounds.prefs:${orgId}`
export function rememberLevels(orgId: string, prefs: Record<string, string>): void {
  try { localStorage.setItem(prefsKey(orgId), JSON.stringify(prefs)) } catch { /* next load */ }
}
/// One conversation's level, written down the moment the server took it —
/// even before the whole list has loaded — without touching the others.
export function rememberLevel(orgId: string, view: string, level: string): void {
  try {
    const levels = JSON.parse(localStorage.getItem(prefsKey(orgId)) || '{}') || {}
    if (level === 'all') delete levels[view]
    else levels[view] = level
    localStorage.setItem(prefsKey(orgId), JSON.stringify(levels))
  } catch { /* next load */ }
}
export function levelOf(orgId: string, view: string): string {
  try { return (JSON.parse(localStorage.getItem(prefsKey(orgId)) || '{}') || {})[view] || 'all' } catch { return 'all' }
}

/// The sound for a message that just arrived, or null for none. Pure, so the
/// rules above are tested rather than hoped for.
export function soundForMessage(m: {
  mine: boolean; channel: string; mentionsMe: boolean; kind?: string; parentId?: string | null
}, ctx: { level: string; open: boolean }): SoundKind | null {
  if (m.mine) return null
  if (ctx.level === 'mute') return null
  const direct = m.channel.startsWith('dm:')
  const important = direct || m.mentionsMe
  // A reply deep in a channel's thread is the Activity inbox's to tell you
  // about, quietly — unless it names you.
  if (m.parentId && !important) return null
  if (ctx.level === 'mentions' && !important) return null
  if (ctx.open) return 'inConversation'
  return important ? 'mention' : 'message'
}
