import React, { useState, useEffect, useRef } from 'react'
import { Dashboard } from './components/Dashboard'
import { Welcome } from './screens/Welcome'
import { SignIn } from './screens/SignIn'
import { Otp } from './screens/Otp'
import { Onboarding } from './screens/Onboarding'
import { disableWebPush } from './utils/push'
import { useT } from './utils/i18n'
import { sampleUser } from './utils/sampleWorkspace'
import { apiBase, readResponse } from './utils/api'
import './theme.css'
import './App.css'

const HTTP_BASE = apiBase(import.meta.env.VITE_API_HOST, window.location, import.meta.env.DEV)

// Where someone is in getting into the product. `app` is the only stage with a
// session behind it; everything before it is the way in.
type Stage = 'welcome' | 'auth' | 'otp' | 'onboarding' | 'app'

function App() {
  const [demo, setDemo] = useState(() => new URLSearchParams(location.search).get('demo') || '')
  const [stage, setStage] = useState<Stage>('welcome')
  const [mode, setMode] = useState<'signup' | 'login'>('signup')
  const [userId, setUserId] = useState<string | null>(null)
  const [orgId, setOrgId] = useState<string>('')
  const [sessionToken, setSessionToken] = useState<string>('')
  // Carried from the email screen to the code screen and nowhere else.
  const [pending, setPending] = useState({ email: '', name: '', inviteCode: '' })

  useEffect(() => {
    try {
      const savedToken = localStorage.getItem('sessionToken')
      const savedUser = localStorage.getItem('userId')
      const savedOrg = localStorage.getItem('orgId')
      const savedApi = localStorage.getItem('apiBase')
      if (savedApi === HTTP_BASE && savedToken && savedUser) {
        setSessionToken(savedToken); setUserId(savedUser); setOrgId(savedOrg || ''); setStage('app')
      }
    } catch { /* Sign-in works without persistence. */ }
  }, [])

  const finishAuth = (token: string, uid: string, org: string, firstTime: boolean) => {
    if (!token || !uid) return
    const workspace = org || ''
    setSessionToken(token)
    setUserId(uid)
    setOrgId(workspace)
    try {
      localStorage.setItem('sessionToken', token); localStorage.setItem('userId', uid)
      localStorage.setItem('orgId', workspace); localStorage.setItem('apiBase', HTTP_BASE)
    } catch { /* Keep this session usable in memory. */ }
    // Onboarding is for a new account, and once. Someone signing in on a
    // second browser has already answered these questions.
    let seen = false
    try { seen = localStorage.getItem(`onboarded:${uid}`) === 'yes' } catch { /* private mode */ }
    setStage(workspace && !seen && firstTime ? 'onboarding' : 'app')
  }

  const finishOnboarding = () => {
    try { localStorage.setItem(`onboarded:${userId}`, 'yes') } catch { /* a preference, not a record */ }
    setStage('app')
  }

  const handleLogout = () => {
    // This browser stops receiving this account's decisions before the
    // session is dropped — the Worker needs the token to forget the subscription.
    disableWebPush(HTTP_BASE, sessionToken).catch(() => {})
    setUserId(null)
    setSessionToken('')
    setStage('welcome')
    try { ['sessionToken', 'userId', 'orgId'].forEach((key) => localStorage.removeItem(key)) } catch {}
  }

  if (demo) return <Dashboard key={demo} sample figmaFixture={demo === 'figma'} userId={sampleUser} orgId="sample" sessionToken="" relayUrl={HTTP_BASE.replace(/^http/, 'ws')} onLogout={() => { setDemo(''); history.replaceState(null, '', location.pathname) }} />

  if (userId && !orgId && stage === 'app') return <WorkspaceRecovery key={sessionToken} token={sessionToken} onJoined={(org) => { setOrgId(org); try { localStorage.setItem('orgId', org) } catch {} }} onLogout={handleLogout} />

  if (stage === 'welcome') {
    return (
      <Welcome
        onStart={() => { setMode('signup'); setStage('auth') }}
        onSignIn={() => { setMode('login'); setStage('auth') }}
        onDemo={() => { setDemo('true'); history.replaceState(null, '', '?demo=true') }}
      />
    )
  }

  if (stage === 'auth') {
    return (
      <SignIn key={`${HTTP_BASE}:${mode}`}
        httpBase={HTTP_BASE}
        mode={mode}
        onBack={() => setStage('welcome')}
        onSwitchMode={setMode}
        onCodeSent={(email, name, inviteCode) => { setPending({ email, name, inviteCode }); setStage('otp') }}
        onDemo={() => { setDemo('true'); history.replaceState(null, '', '?demo=true') }}
        onSignedIn={(token, uid, org) => finishAuth(token, uid, org, mode === 'signup')}
      />
    )
  }

  if (stage === 'otp') {
    return (
      <Otp
        httpBase={HTTP_BASE}
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
        httpBase={HTTP_BASE}
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
      <Dashboard key={`${HTTP_BASE}:${userId}:${sessionToken}`} userId={userId} orgId={orgId} relayUrl={HTTP_BASE.replace(/^http/, 'ws')} sessionToken={sessionToken} onLogout={handleLogout} onJoined={(org) => { setOrgId(org); try { localStorage.setItem("orgId", org) } catch {} }} />
    </div>
  )
}

function WorkspaceRecovery({ token, onJoined, onLogout }: { token: string; onJoined: (org: string) => void; onLogout: () => void }) {
  const t = useT(), [code,setCode]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''), scope=useRef(0), request=useRef<AbortController|null>(null)
  useEffect(() => { scope.current++;return () => {scope.current++;request.current?.abort()} },[token])
  const join=async(event:React.FormEvent) => { event.preventDefault();if(busy)return;const current=scope.current;request.current=new AbortController();setBusy(true);setError('');try{const result=await readResponse(await fetch(`${HTTP_BASE}/invites/accept`,{method:'POST',signal:request.current.signal,headers:{'content-type':'application/json','x-session-token':token},body:JSON.stringify({code:code.trim()})}));if(current===scope.current&&typeof result.orgId==='string'&&result.orgId)onJoined(result.orgId)}catch(e){if(current===scope.current)setError(e instanceof Error?e.message:t('Could not join workspace.'))}finally{if(current===scope.current)setBusy(false)}}
  return <div className="screen"><div className="screen-body"><h1>{t('Join your workspace')}</h1><p>{t('You are signed in. Enter a teammate’s invite code to restore workspace access.')}</p><form onSubmit={join}><label className="field">{t('Invite code')}<input value={code} onChange={e=>setCode(e.target.value)} required autoComplete="off" /></label>{error&&<p className="form-error" role="alert">{error}</p>}<button className="btn btn-primary" disabled={busy||!code.trim()}>{t(busy?'Joining…':'Join workspace')}</button></form><button className="btn btn-quiet" onClick={onLogout}>{t('Sign out')}</button></div></div>
}

export default App
