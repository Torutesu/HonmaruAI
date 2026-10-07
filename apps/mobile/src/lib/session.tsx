// Who is signed in, kept in the Keychain / Keystore (expo-secure-store), and
// the one API client every screen uses (packages/core). Signing in registers
// this phone for push; signing out forgets it (lib/push.ts).
//
// Only the server saying the session is over signs anyone out. A phone just
// restarted often has no network yet when the app opens; that used to read as
// a dead session and asked for a sign-in every time. Now the app stays signed
// in where it was, and looks again until the server answers.

import Constants from 'expo-constants'
import * as SecureStore from 'expo-secure-store'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { AppState } from 'react-native'
import { Api, sessionEnded } from '@honmaru/core'
import type { Me } from '@honmaru/protocol'
import { registerForPush, unregisterPush, watchPushToken } from './push'
import { clearDrafts } from './drafts'

const TOKEN_KEY = 'honmaru.session'
const ORG_KEY = 'honmaru.org'
/// How long to wait before looking again when the server could not be
/// reached: soon at first, then once a minute.
const RETRY_MS = [3000, 10000, 30000, 60000]
/// A request with no network can hang for a minute or more; past this it
/// counts as not reachable, and is tried again later.
const ME_TIMEOUT_MS = 15000

function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timed out')), ms) })
  return Promise.race([promise, late]).finally(() => clearTimeout(timer))
}

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

export function SessionProvider({ children }: { children: ReactNode }) {
  const tokenRef = useRef<string | null>(null)
  const api = useMemo(() => new Api({ base: API_BASE, token: () => tokenRef.current }), [])
  const [ready, setReady] = useState(false)
  const [token, setToken] = useState<string | null>(null)
  const [me, setMe] = useState<Me | null>(null)
  const [orgId, setOrgId] = useState<string | null>(null)

  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const retries = useRef(0)
  const stopRetrying = () => {
    if (retryTimer.current) clearTimeout(retryTimer.current)
    retryTimer.current = null
  }

  const load = useCallback(async (next: string | null) => {
    stopRetrying()
    tokenRef.current = next
    setToken(next)
    if (!next) { setMe(null); return }
    const stored = await SecureStore.getItemAsync(ORG_KEY)
    try {
      const who = await within(api.me(), ME_TIMEOUT_MS)
      if (tokenRef.current !== next) return
      retries.current = 0
      setMe(who)
      const orgs = who.orgs || []
      setOrgId(orgs.some((o) => o.id === stored) ? stored : (who.orgId || orgs[0]?.id || null))
      // Signed in (just now, or still from last time): this phone gets
      // pushes for them. Not awaited — the channels need not wait on a prompt.
      void registerForPush(api)
    } catch (err) {
      if (tokenRef.current !== next) return
      if (sessionEnded(err)) {
        // The server no longer knows this session: signed out.
        tokenRef.current = null
        setToken(null); setMe(null); setOrgId(null)
        await SecureStore.deleteItemAsync(TOKEN_KEY)
        return
      }
      // Not reachable (yet): still signed in, in the workspace of last time,
      // and another look shortly.
      setOrgId((current) => current || stored)
      const wait = RETRY_MS[Math.min(retries.current, RETRY_MS.length - 1)]
      retries.current += 1
      retryTimer.current = setTimeout(() => { if (tokenRef.current === next) void loadRef.current(next) }, wait)
    }
  }, [api])
  const loadRef = useRef(load)
  loadRef.current = load

  // Back in the foreground with the session not yet confirmed: look now
  // rather than wait out the timer.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active' && tokenRef.current && retryTimer.current) {
        retries.current = 0
        void loadRef.current(tokenRef.current)
      }
    })
    return () => { sub.remove(); stopRetrying() }
  }, [])

  // Ready as soon as the saved session is read: the screens show at once,
  // signed in, while the server confirms it (or cannot yet be reached).
  useEffect(() => {
    void SecureStore.getItemAsync(TOKEN_KEY)
      .then((saved) => { const loading = load(saved); setReady(true); return loading })
      .finally(() => setReady(true))
  }, [load])

  useEffect(() => (token ? watchPushToken(api) : undefined), [api, token])

  const value: SessionValue = {
    ready, api, token, me, orgId,
    signIn: async (next, landIn) => {
      await SecureStore.setItemAsync(TOKEN_KEY, next)
      if (landIn) await SecureStore.setItemAsync(ORG_KEY, landIn)
      await load(next)
    },
    signOut: async () => {
      stopRetrying()
      // First, while the session can still say whose phone this was.
      await unregisterPush(api)
      await SecureStore.deleteItemAsync(TOKEN_KEY)
      await SecureStore.deleteItemAsync(ORG_KEY)
      await clearDrafts()
      tokenRef.current = null
      setToken(null); setMe(null); setOrgId(null)
    },
    chooseOrg: async (next) => { await SecureStore.setItemAsync(ORG_KEY, next); setOrgId(next) },
  }
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}

export function useSession(): SessionValue {
  const value = useContext(SessionContext)
  if (!value) throw new Error('useSession outside SessionProvider')
  return value
}
