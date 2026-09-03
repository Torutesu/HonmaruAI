import React, { useState, useEffect } from 'react'
import { Dashboard } from './components/Dashboard'
import './App.css'

// The web client talks to the backend over HTTP for auth and WebSocket for the
// feed. We store one base host and derive both.
const DEFAULT_HOST = import.meta.env.VITE_API_HOST || 'localhost:8787'

function httpBase(host: string) {
  return `http://${host}`
}
function wsBase(host: string) {
  return `ws://${host}`
}

function App() {
  const [userId, setUserId] = useState<string | null>(null)
  const [orgId, setOrgId] = useState<string>('web-team')
  const [sessionToken, setSessionToken] = useState<string>('')
  const [host, setHost] = useState<string>(DEFAULT_HOST)
  const [ready, setReady] = useState(false)

  // Form state
  const [mode, setMode] = useState<'login' | 'signup'>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
    const [inviteCode, setInviteCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

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
      setReady(true)
    }
  }, [])

  const finishAuth = (token: string, uid: string, org: string) => {
    setSessionToken(token)
    setUserId(uid)
    setOrgId(org)
    setReady(true)
    localStorage.setItem('sessionToken', token)
    localStorage.setItem('userId', uid)
    localStorage.setItem('orgId', org)
    localStorage.setItem('host', host)
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const path = mode === 'signup' ? '/auth/signup' : '/auth/login'
            const body: any = { email: email.trim(), password }
      if (mode === 'signup') {
        body.name = name.trim()
        body.orgId = orgId.trim() || 'web-team'
        if (inviteCode.trim()) body.inviteCode = inviteCode.trim()
      }
      const res = await fetch(`${httpBase(host)}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.message || 'Something went wrong.')
        return
      }
      finishAuth(data.token, data.userId, data.orgId || orgId)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const handleLogout = () => {
    setUserId(null)
    setReady(false)
    setSessionToken('')
    setEmail('')
    setPassword('')
    localStorage.removeItem('sessionToken')
    localStorage.removeItem('userId')
  }

  if (!ready || !userId) {
    return (
      <div className="login-page">
        <div className="login-container">
          <h1>Honmaru AI</h1>
          <p className="subtitle">{mode === 'signup' ? 'Create your account' : 'Welcome back'}</p>

          <form onSubmit={handleSubmit}>
            {mode === 'signup' && (
              <div className="form-group">
                <label htmlFor="name">Name:</label>
                <input id="name" type="text" value={name}
                  onChange={(e) => setName(e.target.value)} placeholder="Your name" />
              </div>
            )}

            <div className="form-group">
              <label htmlFor="email">Email:</label>
              <input id="email" type="email" value={email}
                onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" autoFocus />
            </div>

            <div className="form-group">
              <label htmlFor="password">Password:</label>
              <input id="password" type="password" value={password}
                onChange={(e) => setPassword(e.target.value)} placeholder="At least 8 characters" />
            </div>

            {mode === 'signup' && (
              <div className="form-group">
                <label htmlFor="org">Team:</label>
                <input id="org" type="text" value={orgId}
                  onChange={(e) => setOrgId(e.target.value)} placeholder="web-team" />
              </div>
            )}

                        {mode === 'signup' && (
              <div className="form-group">
                <label htmlFor="invite">Invite code (optional):</label>
                <input id="invite" type="text" value={inviteCode}
                  onChange={(e) => setInviteCode(e.target.value)}
                  placeholder="Paste a code to join a team" />
              </div>
            )}

            {error && <div className="create-error">{error}</div>}

            <button type="submit" className="connect-button" disabled={busy}>
              {busy ? 'Please wait…' : mode === 'signup' ? 'Sign up' : 'Log in'}
            </button>
          </form>

          <p className="switch-mode">
            {mode === 'signup' ? 'Already have an account? ' : "Don't have an account? "}
            <button className="link-button" onClick={() => { setError(null); setMode(mode === 'signup' ? 'login' : 'signup') }}>
              {mode === 'signup' ? 'Log in' : 'Sign up'}
            </button>
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="app">
      <Dashboard userId={userId} orgId={orgId} relayUrl={wsBase(host)} sessionToken={sessionToken} />
      <button className="logout-button" onClick={handleLogout}>
        Logout
      </button>
    </div>
  )
}

export default App