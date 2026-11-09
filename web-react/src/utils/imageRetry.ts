import { useCallback, useEffect, useState } from 'react'

// A picture that would not load, and what to draw meanwhile (#824).
//
// A failure belongs to the address that failed: a new address — a photo
// replaced, a logo set again — is tried at once, however the last one went.
// The same address is tried again a little later, twice at most, and once
// more whenever the connection comes back, so a picture that failed on a
// bad connection, or was missing for a while and put back, shows again
// without a reload. Never a loop: a picture that keeps failing stays the
// fallback until its address changes or the device goes back online.

export const IMAGE_RETRY_DELAYS = [15_000, 60_000]

interface State { url: string | null; failed: boolean; tries: number }

export function useImageRetry(url: string | null | undefined, delays: number[] = IMAGE_RETRY_DELAYS) {
  const key = url || null
  const [state, setState] = useState<State>({ url: key, failed: false, tries: 0 })
  // A different address starts afresh, in this same render.
  const current = state.url === key ? state : { url: key, failed: false, tries: 0 }
  if (current !== state) setState(current)

  useEffect(() => {
    if (!current.failed) return
    const retry = () => setState((s) => (s.url === key && s.failed ? { ...s, failed: false, tries: s.tries + 1 } : s))
    const page = typeof window === 'undefined' ? null : window
    page?.addEventListener?.('online', retry)
    const delay = delays[current.tries]
    const timer = delay === undefined ? undefined : setTimeout(retry, delay)
    return () => { page?.removeEventListener?.('online', retry); if (timer !== undefined) clearTimeout(timer) }
  }, [key, current.failed, current.tries, delays])

  const onError = useCallback(() => setState((s) => (s.url === key ? { ...s, failed: true } : s)), [key])
  /// `attempt` is the img's React key: a retry is a new element, so the
  /// browser asks for the picture again.
  return { failed: current.failed, attempt: current.tries, onError }
}
