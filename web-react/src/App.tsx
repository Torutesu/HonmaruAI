import React, { useState, useEffect, useCallback, useRef } from 'react'
import { Dashboard } from './components/Dashboard'
import { Welcome } from './screens/Welcome'
import { SignIn } from './screens/SignIn'
import { Otp } from './screens/Otp'
import { Onboarding } from './screens/Onboarding'
import { PickRepository } from './screens/PickRepository'
import { githubWebConfig, beginGitHubSignIn, readCallback, finishGitHubSignIn } from './utils/githubAuth'
import type { GitHubWebConfig } from './utils/githubAuth'
import { clearCardCache } from './utils/cardCache'
import { parseRoute } from './utils/route'
import { onboardingKey, needsOnboarding, completeOnboarding } from './utils/onboardingProgress'
import { t } from './utils/i18n'
import type { InvitePeek } from './screens/SignIn'
import { disableWebPush } from './utils/push'
import './theme.css'
import './App.css'

// The web client talks to the backend over HTTP for auth and WebSocket for the
// feed. We store one base host and derive both.
const DEFAULT_HOST = import.meta.env.VITE_API_HOST || 'localhost:8787'

// Derive the scheme from the page's own, so one build works in dev over http
// and in production over https. Hardcoding http:// meant a deployed client
// could not reach an https backend at all, and would have put the sign-in
// email and password on the wire in cleartext if pointed at one.
const secure = typeof location !== 'undefined' && location.protocol === 'https:'

function httpBase(host: string) {
  return `${secure ? 'https' : 'http'}://${host}`
}
function wsBase(host: string) {
  return `${secure ? 'wss' : 'ws'}://${host}`
}

// Where someone is in getting into the product. `app` is the only stage with a
// session behind it; everything before it is the way in.
type Stage = 'welcome' | 'auth' | 'otp' | 'onboarding' | 'repo' | 'app'

function App() {
  const [stage, setStage] = useState<Stage>('welcome')
  const [restoring, setRestoring] = useState(true)
  const [restoreError, setRestoreError] = useState(false)
  const [restoreAttempt, setRestoreAttempt] = useState(0)
  const [mode, setMode] = useState<'signup' | 'login'>('signup')
  const [userId, setUserId] = useState<string | null>(null)
  // No placeholder. `web-team` used to sit here as the default, and a returning
  // person on a second browser — nothing in localStorage, and a sign-in reply
  // that carried no org — landed in it: an org nobody is a member of, so the
  // relay refused the socket and the feed simply never arrived.
  const [orgId, setOrgId] = useState<string>('')
  const [sessionToken, setSessionToken] = useState<string>('')
  const [host, setHost] = useState<string>(DEFAULT_HOST)
  // Carried from the email screen to the code screen and nowhere else.
  const [pending, setPending] = useState({ email: '', name: '', inviteCode: '' })
  // GitHub sign-in on the web, where the deployment offers it; and the
  // session that came back before it has a workspace to open.
  const [github, setGithub] = useState<GitHubWebConfig | null>(null)
  const [githubError, setGithubError] = useState<string | null>(null)
  const [pendingGithub, setPendingGithub] = useState<{ token: string; login: string } | null>(null)
  // An invitation the URL carried: what it opens, and a word once it did.
  const [invite, setInvite] = useState<InvitePeek | null>(null)
  const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null)
  useEffect(() => {
    let ignore = false
    githubWebConfig(httpBase(host)).then((cfg) => { if (!ignore) setGithub(cfg) })
    return () => { ignore = true }
  }, [host])

  // A stage that needs a session, reached without one — storage cleared
  // under a running tab, say — goes back to the start. Setting state during
  // render was how this used to be done, which React warns about and which
  // re-renders the tree twice for every frame it happens on.
  useEffect(() => {
    if ((stage === 'onboarding' || stage === 'app') && !userId) setStage('welcome')
  }, [stage, userId])

  // The way back from GitHub: ?code&state on the page. Traded for a session
  // before anything else is decided about where to land.
  const finishAuthRef = useRef<(token: string, uid: string, org: string, firstTime: boolean) => Promise<void>>()
  useEffect(() => {
    const cb = readCallback()
    if (!cb) return
    // Already signed in: the code in the URL is not this person's sign-in
    // (theirs finished) and must not replace their session with another
    // account's. Drop it from the URL and carry on as they were.
    if (localStorage.getItem('sessionToken') && localStorage.getItem('userId')) {
      try {
        const url = new URL(location.href)
        url.searchParams.delete('code'); url.searchParams.delete('state')
        history.replaceState(null, '', url.pathname + url.search + url.hash)
      } catch { /* cosmetic */ }
      return
    }
    const base = httpBase(localStorage.getItem('host') || DEFAULT_HOST)
    finishGitHubSignIn(base, cb)
      .then(({ sessionToken: token, login, orgs }) => {
        if (orgs.length) { void finishAuthRef.current?.(token, login, orgs[0], false); return }
        setSessionToken(token)
        setUserId(login)
        setPendingGithub({ token, login })
        setStage('repo')
      })
      .catch((err) => { setGithubError(err instanceof Error ? err.message : String(err)); setStage('welcome') })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    const savedToken = localStorage.getItem('sessionToken')
    const savedUser = localStorage.getItem('userId')
    const savedOrg = localStorage.getItem('orgId')
    const savedHost = localStorage.getItem('host') || DEFAULT_HOST
    setHost(savedHost)
    setRestoreError(false)
    if (!savedToken || !savedUser) { setRestoring(false); return () => controller.abort() }
    setRestoring(true)
    fetch(`${httpBase(savedHost)}/me`, { headers: { 'x-session-token': savedToken }, signal: controller.signal })
      .then(async (response) => {
        if (controller.signal.aborted) return
        if (response.status === 401 || response.status === 409) {
          for (const key of ['sessionToken', 'userId', 'orgId']) localStorage.removeItem(key)
          clearCardCache()
          setUserId(null); setSessionToken(''); setOrgId(''); setStage('welcome'); setRestoring(false)
          return
        }
        if (!response.ok) throw new Error('Session unavailable')
        const me = await response.json()
        if (controller.signal.aborted) return
        if (typeof me.login !== 'string' || !Array.isArray(me.orgs)) throw new Error('Invalid session response')
        const workspace = me.orgs.some((org: { id: string }) => org.id === savedOrg) ? savedOrg! : me.orgs[0]?.id || ''
        setSessionToken(savedToken); setUserId(me.login); setOrgId(workspace)
        localStorage.setItem('userId', me.login); localStorage.setItem('orgId', workspace)
        setStage(needsOnboarding(localStorage, httpBase(savedHost), me.login) ? 'onboarding' : 'app')
        setRestoring(false)
      })
      .catch(() => {
        if (controller.signal.aborted) return
        if (navigator.onLine === false) {
          // Preserve this browser's existing offline workspace. Server calls
          // remain authenticated; reconnect revalidates before fetching data.
          setSessionToken(savedToken); setUserId(savedUser); setOrgId(savedOrg || '')
          setStage(needsOnboarding(localStorage, httpBase(savedHost), savedUser) ? 'onboarding' : 'app')
          setRestoring(false)
        } else setRestoreError(true)
      })
    const revalidate = () => setRestoreAttempt((value) => value + 1)
    window.addEventListener('online', revalidate)
    return () => { controller.abort(); window.removeEventListener('online', revalidate) }
  }, [restoreAttempt])

  // The link a teammate was sent: #/join/<code>. Signed in, it joins the
  // team and opens the feed there; signed out, it lands on sign-up with the
  // code filled in and the team named. Read on arrival and on every change
  // of the hash, so a link pasted into a tab that is already open works too.
  const joinedRef = useRef<string | null>(null)
  useEffect(() => {
    if (restoring) return
    const onHash = () => {
      const { join } = parseRoute(location.hash)
      if (!join || joinedRef.current === join) return
      joinedRef.current = join
      const base = httpBase(localStorage.getItem('host') || DEFAULT_HOST)
      const token = localStorage.getItem('sessionToken')
      const clear = () => { try { history.replaceState(null, '', location.pathname + location.search + '#/feed') } catch { /* cosmetic */ } }
      if (token && localStorage.getItem('userId')) {
        fetch(`${base}/invites/accept`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-session-token': token },
          body: JSON.stringify({ code: join }),
        })
          .then(async (r) => {
            const data = await r.json().catch(() => ({}))
            if (!r.ok) { setNotice({ text: data.message || t('That invite code is not valid.'), error: true }); return }
            clear()
            switchOrg(data.orgId)
            setNotice({ text: t('You joined the team.') })
          })
          .catch(() => setNotice({ text: t('Could not reach the relay.'), error: true }))
        return
      }
      // Not signed in: the code rides into sign-up, and the Worker says
      // whose team it is so the page can.
      clear()
      setPending((p) => ({ ...p, inviteCode: join }))
      setMode('signup')
      setStage('auth')
      fetch(`${base}/invites/peek?code=${encodeURIComponent(join)}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((peek) => { if (peek) setInvite(peek) })
        .catch(() => { /* the banner is a courtesy */ })
    }
    onHash()
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restoring])
  useEffect(() => {
    if (!notice) return
    const id = setTimeout(() => setNotice(null), notice.error ? 8000 : 4000)
    return () => clearTimeout(id)
  }, [notice])

  /// Which workspace to open. The sign-in reply names one; when it does not —
  /// an older backend, or an account in no org at all — ask, rather than
  /// guessing at a name.
  const resolveOrg = async (token: string, org: string) => {
    if (org) return org
    try {
      const res = await fetch(`${httpBase(host)}/me`, { headers: { 'x-session-token': token } })
      if (res.ok) {
        const me = await res.json()
        if (me.orgs?.length) return me.orgs[0].id as string
      }
    } catch { /* fall through to whatever is stored */ }
    return orgId
  }

  const finishAuth = async (token: string, uid: string, org: string, firstTime: boolean) => {
    finishAuthRef.current = finishAuth
    const workspace = await resolveOrg(token, org)
    setSessionToken(token)
    setUserId(uid)
    setOrgId(workspace)
    localStorage.setItem('sessionToken', token)
    localStorage.setItem('userId', uid)
    localStorage.setItem('orgId', workspace)
    localStorage.setItem('host', host)
    // Onboarding is for a new account, and once. Someone signing in on a
    // second browser has already answered these questions.
    setStage(needsOnboarding(localStorage, httpBase(host), uid, firstTime) ? 'onboarding' : 'app')
  }

  finishAuthRef.current = finishAuth

  /// Moving between the workspaces someone belongs to — their own, and any
  /// team they were invited into. Stored, because it is where they work.
  const switchOrg = (next: string) => {
    setOrgId(next)
    try { localStorage.setItem('orgId', next) } catch { /* private mode */ }
  }

  /// They are out of the workspace that was on screen — they left it, or
  /// somebody removed them, or the session behind it stopped being valid.
  /// There is nothing there to show them now, so ask where they still belong
  /// — the same question a sign-in asks — and go there.
  const leftOrg = async () => {
    // Whatever happens next, the cards of the workspace they are out of
    // are not theirs to keep on this machine.
    clearCardCache()
    try {
      const res = await fetch(`${httpBase(host)}/me`, { headers: { 'x-session-token': sessionToken } })
      if (res.ok) {
        const me = await res.json()
        const next = me.orgs?.find((o: { id: string }) => o.id !== orgId)?.id
        if (next) { switchOrg(next); return }
      }
    } catch { /* nothing to fall back to but the way out */ }
    handleLogout()
  }

  // The Dashboard holds this in the effect that owns the socket, so it has to
  // keep the same identity across renders — a new function every render is a
  // new dependency every render, which would tear the connection down and
  // build it again on each one. The ref keeps the callback stable while the
  // body it calls stays current.
  const leftOrgRef = useRef(leftOrg)
  leftOrgRef.current = leftOrg
  const onLeft = useCallback(() => { void leftOrgRef.current() }, [])

  const finishOnboarding = () => {
    if (userId) completeOnboarding(localStorage, httpBase(host), userId)
    setStage('app')
  }

  const handleLogout = () => {
    // This browser stops receiving this account's decisions before the
    // session is dropped — the Worker needs the token to forget the subscription.
    // Then the session itself ends on the server, so the token left in this
    // browser's history opens nothing.
    const base = httpBase(host)
    const token = sessionToken
    disableWebPush(base, token).catch(() => {}).finally(() => {
      if (token) fetch(`${base}/auth/logout`, { method: 'POST', headers: { 'x-session-token': token } }).catch(() => {})
    })
    setUserId(null)
    setSessionToken('')
    setStage('welcome')
    localStorage.removeItem('sessionToken')
    localStorage.removeItem('userId')
    // The workspace's cards stay readable on this machine otherwise.
    clearCardCache()
  }

  if (restoring) return <div className="screen"><div className="screen-body">
    <p role={restoreError ? 'alert' : 'status'}>{t(restoreError ? 'Could not reach the relay.' : 'Loading…')}</p>
    {restoreError && <button className="btn btn-primary" onClick={() => setRestoreAttempt((value) => value + 1)}>{t('Try again')}</button>}
  </div></div>

  if (stage === 'welcome') {
    return (
      <>
        {githubError && <div className="toasts"><div className="toast error" role="alert" onClick={() => setGithubError(null)}>{githubError}</div></div>}
        <Welcome
          onStart={() => { setMode('signup'); setStage('auth') }}
          onSignIn={() => { setMode('login'); setStage('auth') }}
          onGitHub={github ? () => { beginGitHubSignIn(httpBase(host), github).catch((err) => setGithubError(err instanceof Error ? err.message : String(err))) } : undefined}
        />
      </>
    )
  }

  if (stage === 'repo' && pendingGithub) {
    return (
      <PickRepository
        httpBase={httpBase(host)}
        sessionToken={pendingGithub.token}
        login={pendingGithub.login}
        onPick={(fullName) => { setPendingGithub(null); void finishAuth(pendingGithub.token, pendingGithub.login, fullName, false) }}
        onLogout={() => { setPendingGithub(null); handleLogout() }}
      />
    )
  }

  if (stage === 'auth') {
    return (
      <SignIn
        httpBase={httpBase(host)}
        mode={mode}
        initialInviteCode={pending.inviteCode}
        invite={invite}
        onBack={() => setStage('welcome')}
        onSwitchMode={setMode}
        onCodeSent={(email, name, inviteCode) => { setPending({ email, name, inviteCode }); setStage('otp') }}
        onSignedIn={(token, uid, org) => { void finishAuth(token, uid, org, mode === 'signup') }}
      />
    )
  }

  if (stage === 'otp') {
    return (
      <Otp
        httpBase={httpBase(host)}
        email={pending.email}
        name={pending.name}
        inviteCode={pending.inviteCode}
        onBack={() => setStage('auth')}
        onVerified={(token, uid, org, created) => { void finishAuth(token, uid, org, created) }}
      />
    )
  }

  if (stage === 'onboarding' && userId) {
    return (
      <Onboarding
        key={`${httpBase(host)}:${userId}`}
        progressKey={onboardingKey(httpBase(host), userId)}
        httpBase={httpBase(host)}
        orgId={orgId}
        sessionToken={sessionToken}
        onDone={finishOnboarding}
      />
    )
  }

  if (!userId) {
    // A stage that needs a session and has none: back to the start rather than
    // a blank screen. The effect above does the setting; rendering nothing for
    // one frame is the whole cost.
    return null
  }

  return (
    <div className="app">
      {notice && (
        <div className="toasts app-toasts">
          <div className={`toast${notice.error ? ' error' : ''}`} role={notice.error ? 'alert' : 'status'} onClick={() => setNotice(null)}>{notice.text}</div>
        </div>
      )}
      {/* Keyed by workspace: switching teams is a new Dashboard, not the old
          one with a different orgId. State, the synced flag and the card
          cache all restart, so nothing of one workspace is ever held — or
          written to the cache — under the name of another. */}
      <Dashboard
        key={orgId}
        userId={userId}
        orgId={orgId}
        relayUrl={wsBase(host)}
        sessionToken={sessionToken}
        onLogout={handleLogout}
        onSwitchOrg={switchOrg}
        onLeft={onLeft}
      />
    </div>
  )
}

export default App
