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
// cache, the same on every browser — and every sound is under half a second
// except the Jam ring, which repeats until it is answered or gives up.
//
// Settings are per device (a laptop and a phone on one desk should not both
// knock), in localStorage.

import { isQuiet } from './quiet'

export type SoundKind = 'mention' | 'message' | 'inConversation' | 'sent' | 'decision' | 'jamJoin' | 'jamLeave' | 'ring'

export interface SoundSettings {
  enabled: boolean
  volume: number // 0..1
  mentions: boolean // DMs and @mentions
  channels: boolean // every message in a channel you have not muted
  inConversation: boolean
  sent: boolean
  decisions: boolean
  jam: boolean // join, leave, ring
}

export const DEFAULT_SOUNDS: SoundSettings = {
  enabled: true, volume: 0.6,
  mentions: true, channels: false, inConversation: true, sent: true, decisions: true, jam: true,
}

const KEY = 'sounds.v1'

export function loadSoundSettings(): SoundSettings {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || 'null')
    return raw && typeof raw === 'object' ? { ...DEFAULT_SOUNDS, ...raw } : { ...DEFAULT_SOUNDS }
  } catch { return { ...DEFAULT_SOUNDS } }
}

export function saveSoundSettings(next: SoundSettings): void {
  try { localStorage.setItem(KEY, JSON.stringify(next)) } catch { /* this device only, and not today */ }
}

/// Which setting lets a kind of sound play.
function allowedBy(s: SoundSettings, kind: SoundKind): boolean {
  if (!s.enabled) return false
  switch (kind) {
    case 'mention': return s.mentions
    case 'message': return s.channels
    case 'inConversation': return s.inConversation
    case 'sent': return s.sent
    case 'decision': return s.decisions
    case 'jamJoin': case 'jamLeave': case 'ring': return s.jam
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

/// One note: a tone that rises and falls quickly, so it never clicks.
function note(ac: AudioContext, out: AudioNode, { freq, at, dur, type = 'sine', gain = 1, slideTo }: { freq: number; at: number; dur: number; type?: OscillatorType; gain?: number; slideTo?: number }) {
  const osc = ac.createOscillator()
  const env = ac.createGain()
  osc.type = type
  osc.frequency.setValueAtTime(freq, at)
  if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, at + dur)
  env.gain.setValueAtTime(0.0001, at)
  env.gain.exponentialRampToValueAtTime(gain, at + 0.012)
  env.gain.exponentialRampToValueAtTime(0.0001, at + dur)
  osc.connect(env).connect(out)
  osc.start(at)
  osc.stop(at + dur + 0.02)
}

/// The sounds themselves. Pitches are from one scale (D major), so any two
/// that happen together do not clash.
function render(kind: SoundKind, ac: AudioContext, out: AudioNode) {
  const t = ac.currentTime + 0.01
  switch (kind) {
    case 'mention': // a knock-knock: two quick, warm, rising taps
      note(ac, out, { freq: 587.33, at: t, dur: 0.11, type: 'triangle', gain: 0.9 })
      note(ac, out, { freq: 880, at: t + 0.12, dur: 0.16, type: 'triangle', gain: 0.8 })
      break
    case 'message': // one soft drop
      note(ac, out, { freq: 739.99, at: t, dur: 0.14, type: 'sine', gain: 0.45, slideTo: 659.25 })
      break
    case 'inConversation': // a tick, barely there
      note(ac, out, { freq: 1174.66, at: t, dur: 0.06, type: 'sine', gain: 0.18 })
      break
    case 'sent': // a small upward swish
      note(ac, out, { freq: 880, at: t, dur: 0.09, type: 'sine', gain: 0.22, slideTo: 1318.51 })
      break
    case 'decision': // three notes: something is waiting on you
      note(ac, out, { freq: 587.33, at: t, dur: 0.14, type: 'sine', gain: 0.7 })
      note(ac, out, { freq: 739.99, at: t + 0.1, dur: 0.14, type: 'sine', gain: 0.6 })
      note(ac, out, { freq: 1108.73, at: t + 0.2, dur: 0.26, type: 'sine', gain: 0.55 })
      break
    case 'jamJoin': // up
      note(ac, out, { freq: 659.25, at: t, dur: 0.12, type: 'sine', gain: 0.55 })
      note(ac, out, { freq: 987.77, at: t + 0.1, dur: 0.18, type: 'sine', gain: 0.5 })
      break
    case 'jamLeave': // down
      note(ac, out, { freq: 987.77, at: t, dur: 0.12, type: 'sine', gain: 0.45 })
      note(ac, out, { freq: 659.25, at: t + 0.1, dur: 0.2, type: 'sine', gain: 0.4 })
      break
    case 'ring': // one ring of a call: a bright double pulse
      for (const off of [0, 0.18]) {
        note(ac, out, { freq: 880, at: t + off, dur: 0.14, type: 'triangle', gain: 0.6 })
        note(ac, out, { freq: 1108.73, at: t + off, dur: 0.14, type: 'sine', gain: 0.35 })
      }
      break
  }
}

let lastAt = 0
const QUIET_MS = 1500
// Sounds that are answers to what you just did are never swallowed by the
// burst rule — you pressed send, you hear it.
const PERSONAL: SoundKind[] = ['sent', 'jamJoin', 'jamLeave', 'ring']

/// Play a sound, if the settings, the tab and the moment allow it.
/// `preview` plays regardless — for the settings screen's ▶ buttons.
export function playSound(kind: SoundKind, { preview = false }: { preview?: boolean } = {}): boolean {
  const settings = loadSoundSettings()
  if (!preview) {
    if (!allowedBy(settings, kind)) return false
    // Notifications paused, or outside the person's hours: no sound either,
    // except for what they did themselves (sent, joined, left).
    if (isQuiet() && !PERSONAL.includes(kind)) return false
    if (!leader && !PERSONAL.includes(kind)) return false
    const now = Date.now()
    if (!PERSONAL.includes(kind)) {
      if (now - lastAt < QUIET_MS) return false
      lastAt = now
    }
  }
  const ac = audio()
  if (!ac || ac.state !== 'running') return false
  const master = ac.createGain()
  master.gain.value = Math.max(0, Math.min(1, settings.volume)) * 0.5
  master.connect(ac.destination)
  render(kind, ac, master)
  setTimeout(() => { try { master.disconnect() } catch { /* already gone */ } }, 1200)
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
