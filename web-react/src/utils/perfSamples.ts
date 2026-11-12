import { desktopApp } from './desktop'

// How long the chat's own waits take, sent to the Worker's POST /perf
// (#845, findings 6–7): how long a message waits in its conversation's
// queue against how long its own POST takes, and how often opening a
// conversation reads it again instead of using what was kept.
//
// A sample is a kind and a number. Nothing else leaves: no message, no
// conversation, no person. Kept in memory and sent at most once a minute,
// and when the page is hidden; a batch that cannot be sent is dropped —
// timings are worth less than the requests they would cost.

export type PerfKind =
  | 'send.queue' | 'send.depth' | 'send.http' | 'send.server'
  | 'open.fresh' | 'open.revalidate' | 'open.cold' | 'open.remount'
  | 'thread.pages' | 'read.server'

const MAX_BUFFER = 200
const BATCH = 50
const EVERY_MS = 60_000

let target: { httpBase: string; sessionToken: string } | null = null
let buffer: { k: PerfKind; v: number }[] = []
let timer: ReturnType<typeof setTimeout> | null = null
let listening = false

export function configurePerfSamples(next: { httpBase: string; sessionToken: string } | null) {
  // Another account or server: what was measured for the last one is not sent as this one's.
  if (!next || !target || next.httpBase !== target.httpBase || next.sessionToken !== target.sessionToken) buffer = []
  target = next
  if (next && !listening && typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    listening = true
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushPerfSamples() })
  }
}

export function perfSample(k: PerfKind, v: number) {
  if (!target || !Number.isFinite(v) || v < 0) return
  if (buffer.length >= MAX_BUFFER) return
  buffer.push({ k, v: Math.round(v) })
  if (!timer) timer = setTimeout(() => { timer = null; flushPerfSamples() }, EVERY_MS)
}

/// The server's own total for a response, from its Server-Timing header.
export function serverTotal(res: Response | null | undefined): number | null {
  const header = res?.headers?.get?.('server-timing') || ''
  const m = /(?:^|,)\s*total;dur=([0-9.]+)/.exec(header)
  return m ? Number(m[1]) : null
}

export function flushPerfSamples() {
  if (!target || !buffer.length || typeof fetch !== 'function') return
  const { httpBase, sessionToken } = target
  while (buffer.length) {
    const samples = buffer.splice(0, BATCH)
    void fetch(`${httpBase}/perf`, {
      method: 'POST', keepalive: true,
      headers: { 'content-type': 'application/json', 'x-session-token': sessionToken },
      body: JSON.stringify({ client: desktopApp() ? 'desktop' : 'web', samples }),
    }).catch(() => {})
  }
}

/// For tests.
export function pendingPerfSamples() { return buffer.slice() }
