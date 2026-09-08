import React, { useState, useEffect } from 'react'
import { Dashboard } from './components/Dashboard'
import { Welcome } from './screens/Welcome'
import { SignIn } from './screens/SignIn'
import { Otp } from './screens/Otp'
import { Onboarding } from './screens/Onboarding'
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
type Stage = 'welcome' | 'auth' | 'otp' | 'onboarding' | 'app'

function App() {
  const [stage, setStage] = useState<Stage>('welcome')
  const [mode, setMode] = useState<'signup' | 'login'>('signup')
  const [userId, setUserId] = useState<string | null>(null)
  const [orgId, setOrgId] = useState<string>('web-team')
  const [sessionToken, setSessionToken] = useState<string>('')
  const [host, setHost] = useState<string>(DEFAULT_HOST)
  // Carried from the email screen to the code screen and nowhere else.
  const [pending, setPending] = useState({ email: '', name: '', inviteCode: '' })

  useEffect(() => {
    const savedToken = localStorage.getItem('sessionToken')
    const savedUser = localStorage.getItem('userId')
    const savedOrg = localStorage.getItem('orgId')
    const savedHost = localStorage.getItem('host')
    if (savedHost) setHost(savedHost)
    if (savedOrg) setOrgId(savedOrg)
    if (savedToken && savedUser) {
      setSessionToken(savedToken)
      setUserId(savedUser)
      setStage('app')
    }
  }, [])

  const finishAuth = (token: string, uid: string, org: string, firstTime: boolean) => {
    const workspace = org || orgId
    setSessionToken(token)
    setUserId(uid)
    setOrgId(workspace)
    localStorage.setItem('sessionToken', token)
    localStorage.setItem('userId', uid)
    localStorage.setItem('orgId', workspace)
    localStorage.setItem('host', host)
    // Onboarding is for a new account, and once. Someone signing in on a
    // second browser has already answered these questions.
    let seen = false
    try { seen = localStorage.getItem('onboarded') === 'yes' } catch { /* private mode */ }
    setStage(!seen && firstTime ? 'onboarding' : 'app')
  }

  const finishOnboarding = () => {
    try { localStorage.setItem('onboarded', 'yes') } catch { /* a preference, not a record */ }
    setStage('app')
  }

  const handleLogout = () => {
    // This browser stops receiving this account's decisions before the
    // session is dropped — the Worker needs the token to forget the subscription.
    disableWebPush(httpBase(host), sessionToken).catch(() => {})
    setUserId(null)
    setSessionToken('')
    setStage('welcome')
    localStorage.removeItem('sessionToken')
    localStorage.removeItem('userId')
  }

  if (stage === 'welcome') {
    return (
      <Welcome
        onStart={() => { setMode('signup'); setStage('auth') }}
        onSignIn={() => { setMode('login'); setStage('auth') }}
      />
    )
  }

  if (stage === 'auth') {
    return (
      <SignIn
        httpBase={httpBase(host)}
        mode={mode}
        onBack={() => setStage('welcome')}
        onSwitchMode={setMode}
        onCodeSent={(email, name, inviteCode) => { setPending({ email, name, inviteCode }); setStage('otp') }}
        onSignedIn={(token, uid, org) => finishAuth(token, uid, org, mode === 'signup')}
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
        onVerified={(token, uid, org, created) => finishAuth(token, uid, org, created)}
      />
    )
  }

  if (stage === 'onboarding' && userId) {
    return (
      <Onboarding
        httpBase={httpBase(host)}
        orgId={orgId}
        sessionToken={sessionToken}
        onDone={finishOnboarding}
      />
    )
  }

  if (!userId) {
    // A stage that needs a session and has none: back to the start rather than
    // a blank screen.
    setStage('welcome')
    return null
  }

  return (
    <div className="app">
      <Dashboard userId={userId} orgId={orgId} relayUrl={wsBase(host)} sessionToken={sessionToken} onLogout={handleLogout} />
    </div>
  )
}

export default App
