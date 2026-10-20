const recoveryKey = 'honmaru:chunk-recovery'
const cooldownMs = 5 * 60 * 1000

/** Only our hashed application assets qualify; ordinary render errors do not. */
export function isMissingAppChunk(error: unknown, origin: string): boolean {
  if (!(error instanceof Error) || !origin || !/(Failed to fetch dynamically imported module|error loading dynamically imported module)/i.test(error.message)) return false
  const address = error.message.match(/https?:\/\/[^\s]+/)?.[0]
  if (!address) return false
  try {
    const url = new URL(address)
    return url.origin === origin && /^\/assets\/[^/]+-[\w-]+\.js$/.test(url.pathname)
  } catch { return false }
}

/** Persist before reloading so an offline or broken release cannot loop. */
export function recoverMissingAppChunk(error: unknown, options: {
  origin: string; online: boolean; storage: Pick<Storage, 'getItem' | 'setItem'>;
  reload: () => void; now?: number;
}): boolean {
  if (!options.online || !isMissingAppChunk(error, options.origin)) return false
  const now = options.now ?? Date.now()
  try {
    const previous = Number(options.storage.getItem(recoveryKey))
    if (previous > 0 && now - previous < cooldownMs) return false
    options.storage.setItem(recoveryKey, String(now))
    options.reload()
    return true
  } catch { return false }
}
