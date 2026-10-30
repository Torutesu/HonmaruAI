import { useLayoutEffect, useState } from 'react'

/// A successful preference save/read can confirm the same boolean again.
/// Its revision still resets a server-off answer and restarts current requests.
export function useTranslationPreference(enabled: boolean | null, revision: number, identity: string) {
  const scope = JSON.stringify([identity, enabled, revision])
  const [offScope, setOffScope] = useState<string | null>(null)
  useLayoutEffect(() => { setOffScope(null) }, [scope])
  return {
    scope,
    off: enabled !== true || offScope === scope,
    setServerOff: (off: boolean) => setOffScope(off ? scope : null),
  }
}
