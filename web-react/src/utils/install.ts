// The app as an app: the service worker that keeps the shell for offline,
// and the browser's offer to install, held until the person asks for it
// from You rather than sprung on them on the first visit.

let deferred: (Event & { prompt: () => Promise<void> }) | null = null
const listeners = new Set<() => void>()

export function registerShell(): void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return
  // In development Vite serves modules the worker would cache stale.
  if (!import.meta.env.PROD) return
  navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => { /* the app works without it */ })
}

export function watchInstallPrompt(): void {
  if (typeof window === 'undefined') return
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault()
    deferred = e as Event & { prompt: () => Promise<void> }
    listeners.forEach((fn) => fn())
  })
  window.addEventListener('appinstalled', () => { deferred = null; listeners.forEach((fn) => fn()) })
}

export function canInstall(): boolean { return deferred !== null }

export async function promptInstall(): Promise<void> {
  const e = deferred
  if (!e) return
  deferred = null
  listeners.forEach((fn) => fn())
  try { await e.prompt() } catch { /* declined, or already installed */ }
}

export function onInstallChange(fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}
