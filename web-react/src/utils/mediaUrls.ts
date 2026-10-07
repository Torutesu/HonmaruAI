// A file's address, kept fresh. A file is kept by its id; its address is
// signed for a while (on the media origin, ten to twenty minutes) and says
// until when (`expiresAt`). Shortly before it runs out — or when the browser
// says it no longer opens — new addresses are asked for, many at once
// (POST /media/urls), and every place that shows the file takes them up.

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

/// Who asks for new addresses: the workspace open now.
export function configureMediaUrls(next: { httpBase: string; orgId: string; sessionToken: string } | null) {
  if (api?.orgId !== next?.orgId) fresh.clear()
  api = next
}

/// How early to renew: a minute before it runs out.
const EARLY = 60_000

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
  for (const fn of listeners) fn()
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
    const at = addressOf(f).expiresAt
    return at && at < min ? at : min
  }, Infinity)
  useEffect(() => {
    if (!Number.isFinite(soonest)) return
    const due = soonest - EARLY - Date.now()
    const go = () => { for (const f of list) { const a = addressOf(f); if (a.expiresAt && a.expiresAt - EARLY <= Date.now()) renew(f.id) } }
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
