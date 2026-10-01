// Who is signed in, kept in the Keychain / Keystore (expo-secure-store), and
// the one API client every screen uses (packages/core). Signing in registers
// this phone for push; signing out forgets it (lib/push.ts).

import Constants from 'expo-constants'
import * as SecureStore from 'expo-secure-store'
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { Api } from '@honmaru/core'
import type { Me } from '@honmaru/protocol'
import { registerForPush, unregisterPush, watchPushToken } from './push'

const TOKEN_KEY = 'honmaru.session'
const ORG_KEY = 'honmaru.org'

export const API_BASE: string = (Constants.expoConfig?.extra as { apiBase?: string } | undefined)?.apiBase
  || 'https://tiktokforwork.torubj0904.workers.dev'

interface SessionValue {
  ready: boolean
  api: Api
  token: string | null
  me: Me | null
  orgId: string | null
  /// `orgId`: where to land — the workspace an invitation just let them into.
  signIn: (token: string, orgId?: string | null) => Promise<void>
  signOut: () => Promise<void>
  chooseOrg: (orgId: string) => Promise<void>
}

const SessionContext = createContext<SessionValue | null>(null)

// The API reads credentials only when making a request, independently of React render.
function createSessionClient() {
  let credential: string | null = null
  return {
    api: new Api({ base: API_BASE, token: () => credential }),
    setCredential: (next: string | null) => { credential = next },
  }
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [{ api, setCredential }] = useState(createSessionClient)
  const [ready, setReady] = useState(false)
  const [token, setToken] = useState<string | null>(null)
  const [me, setMe] = useState<Me | null>(null)
  const [orgId, setOrgId] = useState<string | null>(null)

  const load = useCallback(async (next: string | null) => {
    setCredential(next)
    setToken(next)
    if (!next) { setMe(null); return }
    try {
      const who = await api.me()
      setMe(who)
      const stored = await SecureStore.getItemAsync(ORG_KEY)
      const orgs = who.orgs || []
      setOrgId(orgs.some((o) => o.id === stored) ? stored : (who.orgId || orgs[0]?.id || null))
      // Signed in (just now, or still from last time): this phone gets
      // pushes for them. Not awaited — the channels need not wait on a prompt.
      void registerForPush(api)
    } catch {
      // A session the server no longer knows: signed out.
      setCredential(null)
      setToken(null)
      await SecureStore.deleteItemAsync(TOKEN_KEY)
    }
  }, [api, setCredential])

  useEffect(() => {
    void SecureStore.getItemAsync(TOKEN_KEY).then(load).finally(() => setReady(true))
  }, [load])

  useEffect(() => (token ? watchPushToken(api) : undefined), [api, token])

  const chooseOrg = useCallback(async (next: string) => {
    await SecureStore.setItemAsync(ORG_KEY, next)
    setOrgId(next)
  }, [])

  const value: SessionValue = {
    ready, api, token, me, orgId,
    signIn: async (next, landIn) => {
      await SecureStore.setItemAsync(TOKEN_KEY, next)
      if (landIn) await SecureStore.setItemAsync(ORG_KEY, landIn)
      await load(next)
    },
    signOut: async () => {
      // First, while the session can still say whose phone this was.
      await unregisterPush(api)
      await SecureStore.deleteItemAsync(TOKEN_KEY)
      await SecureStore.deleteItemAsync(ORG_KEY)
      setCredential(null)
      setToken(null); setMe(null); setOrgId(null)
    },
    chooseOrg,
  }
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}

export function useSession(): SessionValue {
  const value = useContext(SessionContext)
  if (!value) throw new Error('useSession outside SessionProvider')
  return value
}
