// A file's address, kept fresh. A file is kept by its id; its address is
// signed for a while (on the media origin, ten to twenty minutes) and says
// until when (`expiresAt`). Shortly before it runs out — or when the browser
// says it no longer opens — new addresses are asked for, many at once
// (POST /media/urls), and every place that shows the file takes them up.
//
// Asking can fail: offline, or the server down for a moment. A file whose
// address could not be renewed is asked for again, waiting twice as long
// each time up to five minutes, and at once when the browser is back online
// or the page is looked at again — for as long as something shows it. One
// the server answers without (not the reader's to see any more, or gone) is
// not asked for again until a newer address for it comes another way.

import { useEffect, useReducer } from 'react'
import type { FileRef } from '../types/card'

/// An address as the browser fetches it: the media origin's are whole,
/// the API's own /files ones are relative to it.
export const fileSrc = (base: string, url: string) => (/^https?:\/\//.test(url) ? url : `${base}${url}`)

interface Fresh { url: string; expiresAt: number }
const fresh = new Map<string, Fresh>()
const listeners = new Set<() => void>()
let api: { httpBase: string; orgId: string; sessionToken: string } | null = null
let queued = new Set<string>()
let timer: ReturnType<typeof setTimeout> | null = null
const asked = new Map<string, number>()
/// Files whose renewal failed: how many times running, and when to ask again.
const failed = new Map<string, { times: number; at: number }>()
/// Files the server would not renew, and when it said so.
const refused = new Map<string, number>()

/// Who asks for new addresses: the workspace open now.
export function configureMediaUrls(next: { httpBase: string; orgId: string; sessionToken: string } | null) {
  if (api?.orgId !== next?.orgId) { fresh.clear(); failed.clear(); refused.clear() }
  api = next
}

/// How early to renew: a minute before it runs out.
const EARLY = 60_000
/// How long to wait after a renewal fails: ten seconds, doubling, up to five minutes.
const retryAfter = (times: number) => Math.min(10_000 * 2 ** (times - 1), 300_000)

async function flush() {
  timer = null
  const ids = [...queued]
  queued = new Set()
  if (!api || !ids.length) return
  const res = await fetch(`${api.httpBase}/media/urls`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-session-token': api.sessionToken },
    body: JSON.stringify({ orgId: api.orgId, ids }),
  }).catch(() => null)
  const data = res?.ok ? await res.json().catch(() => null) : null
  const files = (data?.files || {}) as Record<string, Fresh>
  for (const [id, f] of Object.entries(files)) if (f?.url) fresh.set(id, { url: f.url, expiresAt: Number(f.expiresAt) || 0 })
  for (const id of ids) {
    if (files[id]?.url) { failed.delete(id); refused.delete(id) }
    else if (data || res?.status === 403 || res?.status === 404) { failed.delete(id); refused.set(id, Date.now()) }
    else {
      const times = (failed.get(id)?.times || 0) + 1
      failed.set(id, { times, at: Date.now() + retryAfter(times) })
    }
  }
  for (const fn of listeners) fn()
}

/// Back online, or the page looked at again: what failed is asked for now
/// (or once the ten seconds between asks for one file are up).
export function retryFailed() {
  if (!failed.size) return
  for (const [id, f] of failed) failed.set(id, { ...f, at: (asked.get(id) || 0) + 10_000 })
  for (const fn of listeners) fn()
}
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  window.addEventListener('online', retryFailed)
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') retryFailed() })
}

/// Ask for a new address for this file, with others asked for about now.
/// Not more than once in ten seconds for the same file.
export function renew(id: string) {
  const last = asked.get(id) || 0
  if (Date.now() - last < 10_000) return
  asked.set(id, Date.now())
  queued.add(id)
  if (!timer) timer = setTimeout(() => { void flush() }, 50)
}

/// The best address known for a file: the one it came with, or a newer one.
export function addressOf(file: FileRef): Fresh {
  const own = { url: file.url, expiresAt: file.expiresAt || 0 }
  const got = fresh.get(file.id)
  return got && got.expiresAt > own.expiresAt ? got : own
}

/// When to ask for a new address for a file (ms), or null when not to: it
/// has none that runs out, or the server would not renew the one it has.
/// One whose renewal failed waits its turn to be tried again.
export function renewalAt(file: FileRef): number | null {
  const { expiresAt } = addressOf(file)
  if (!expiresAt) return null
  const no = refused.get(file.id)
  if (no !== undefined && expiresAt <= no + EARLY) return null
  return Math.max(expiresAt - EARLY, failed.get(file.id)?.at || 0)
}

/// For a set of files: the address to show each by, renewed before it runs
/// out, and a handler for when one will not open.
export function useFileUrls(base: string, files: FileRef[] | undefined) {
  const [, redraw] = useReducer((n: number) => n + 1, 0)
  useEffect(() => {
    listeners.add(redraw)
    return () => { listeners.delete(redraw) }
  }, [])
  const list = files || []
  const soonest = list.reduce((min, f) => {
    const at = renewalAt(f)
    return at !== null && at < min ? at : min
  }, Infinity)
  useEffect(() => {
    if (!Number.isFinite(soonest)) return
    const due = soonest - Date.now()
    const go = () => { for (const f of list) { const at = renewalAt(f); if (at !== null && at <= Date.now()) renew(f.id) } }
    if (due <= 0) { go(); return }
    const t = setTimeout(go, Math.min(due, 2 ** 31 - 1))
    return () => clearTimeout(t)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [soonest, list.map((f) => f.id).join(',')])
  return {
    src: (f: FileRef) => fileSrc(base, addressOf(f).url),
    /// It would not open: perhaps its address ran out while hidden.
    stale: (f: FileRef) => renew(f.id),
  }
}

/// Where to play a Jam's recording from: an address signed for whoever is
/// looking, asked for when the player is drawn (POST /channels/jam/audio-url).
/// The link in the message itself opens nothing once recordings are signed;
/// a recording from before plays from it as it is.
export async function recordingAddress(link: string): Promise<string> {
  const id = link.split('/').pop() || ''
  if (!api) return link
  const res = await fetch(`${api.httpBase}/channels/jam/audio-url`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-session-token': api.sessionToken },
    body: JSON.stringify({ orgId: api.orgId, id }),
  }).catch(() => null)
  const data = res?.ok ? await res.json().catch(() => null) : null
  return typeof data?.url === 'string' ? data.url : link
}
