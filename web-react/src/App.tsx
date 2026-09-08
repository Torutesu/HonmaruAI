import React, { useState, useEffect } from 'react'
import { Dashboard } from './components/Dashboard'
import { BrandMark, Icon } from './components/Icon'
import { disableWebPush } from './utils/push'
import { apiBase, readResponse } from './utils/api'
import './App.css'

const HTTP_BASE = apiBase(import.meta.env.VITE_API_HOST, window.location, import.meta.env.DEV)

function App() {
  const [userId, setUserId] = useState<string | null>(null)
  const [orgId, setOrgId] = useState('')
  const [sessionToken, setSessionToken] = useState('')
  const [mode, setMode] = useState<'login' | 'signup'>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [inviteCode, setInviteCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    try {
      const token = localStorage.getItem('sessionToken')
      const user = localStorage.getItem('userId')
      const org = localStorage.getItem('orgId')
      const savedApi = localStorage.getItem('apiBase')
      if (token && user && org && savedApi === HTTP_BASE) {
        setSessionToken(token); setUserId(user); setOrgId(org)
      }
    } catch { /* Private browsing can disable persistence; sign-in still works. */ }
  }, [])

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (busy) return
    setBusy(true); setError(null)
    try {
      const body = { email: email.trim(), password, ...(mode === 'signup' ? { name: name.trim(), ...(inviteCode.trim() ? { inviteCode: inviteCode.trim() } : {}) } : {}) }
      const response = await fetch(`${HTTP_BASE}/auth/${mode === 'signup' ? 'signup' : 'login'}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      })
      const data = await readResponse(response)
      const uid = data.login || data.userId
      if (!data.token || !uid || !data.orgId) throw new Error('Sign-in could not be completed. Please try again.')
      setSessionToken(data.token); setUserId(uid); setOrgId(data.orgId); setPassword('')
      try {
        localStorage.setItem('sessionToken', data.token)
        localStorage.setItem('userId', uid)
        localStorage.setItem('orgId', data.orgId)
        localStorage.setItem('apiBase', HTTP_BASE)
      } catch { /* This session remains usable without local storage. */ }
    } catch (err) {
      setError(err instanceof TypeError ? 'Unable to reach Honmaru. Check your connection and try again.' : err instanceof Error ? err.message : 'Sign-in failed. Please try again.')
    } finally { setBusy(false) }
  }

  const handleLogout = (reason?: string) => {
    disableWebPush(HTTP_BASE, sessionToken).catch(() => {})
    setUserId(null); setSessionToken(''); setPassword(''); setError(reason || null)
    try { ['sessionToken', 'userId', 'orgId'].forEach((key) => localStorage.removeItem(key)) } catch {}
  }

  if (userId) return <div className="app"><Dashboard userId={userId} orgId={orgId} relayUrl={HTTP_BASE.replace(/^http/, 'ws')} sessionToken={sessionToken} onLogout={handleLogout} /></div>

  return (
    <main className="login-page">
      <section className="welcome-panel" aria-label="About Honmaru AI">
        <a className="wordmark" href="/"><BrandMark /><span>Honmaru<span className="wordmark-ai">AI</span></span></a>
        <div className="welcome-content">
          <div className="eyebrow"><span className="eyebrow-dot" /> A clearer way to work</div>
          <h1>Less back and forth.<br /><span>More moving forward.</span></h1>
          <p>Your team’s requests, ready for a decision. Review the context, give an answer, and get on with your day.</p>
          <div className="workflow-preview" aria-label="Example decision workflow">
            <div className="preview-topline"><span><Icon name="sparkle" size={16} /> YOUR DECISION FEED</span><span className="example-label">Example</span></div>
            <div className="preview-card">
              <div className="preview-card-meta"><span className="kind kind-approval">Approval</span><span>Product launch</span></div>
              <h2>Ready to move forward?</h2>
              <p>The context you need. One clear next step.</p>
              <div className="preview-context"><span>REQUEST</span><span>Review the launch proposal</span></div>
              <div className="preview-actions"><span>Reply</span><span className="preview-approve"><Icon name="check" size={15} /> Approve</span></div>
            </div>
            <div className="preview-receipt"><span className="receipt-icon"><Icon name="check" size={14} /></span><span>A shared record of what was decided.</span><Icon name="arrow" size={16} /></div>
          </div>
        </div>
        <div className="welcome-footer"><span>Context. Decision. Progress.</span><span>Honmaru AI</span></div>
      </section>
      <section className="login-form-panel">
        <div className="mobile-wordmark wordmark"><BrandMark /> Honmaru AI</div>
        <div className="login-container">
          <span className="eyebrow">Your workspace, in focus</span>
          <h2>{mode === 'signup' ? 'Make room for better work.' : 'Welcome back.'}</h2>
          <p className="subtitle">{mode === 'signup' ? 'Create an account to start your decision feed.' : 'Sign in and pick up where your team left off.'}</p>
          <form onSubmit={handleSubmit}>
            {mode === 'signup' && <div className="form-group"><label htmlFor="name">Full name</label><input id="name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" required maxLength={100} disabled={busy} /></div>}
            <div className="form-group"><label htmlFor="email">Email address</label><input id="email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" required disabled={busy} /></div>
            <div className="form-group"><label htmlFor="password">Password</label><input id="password" type="password" autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} value={password} onChange={(e) => setPassword(e.target.value)} placeholder={mode === 'signup' ? 'At least 8 characters' : 'Enter your password'} required minLength={mode === 'signup' ? 8 : undefined} disabled={busy} /></div>
            {mode === 'signup' && <div className="form-group"><label htmlFor="invite">Team invite code <span>Optional</span></label><input id="invite" value={inviteCode} onChange={(e) => setInviteCode(e.target.value)} placeholder="Join an existing workspace" autoComplete="off" disabled={busy} /><small>Leave this blank to create your own workspace.</small></div>}
            {error && <div className="create-error auth-error" role="alert">{error}</div>}
            <button type="submit" className="connect-button" disabled={busy}>{busy ? 'Connecting…' : mode === 'signup' ? 'Create your account' : 'Sign in'}{!busy && <Icon name="arrow" size={18} />}</button>
          </form>
          <p className="switch-mode">{mode === 'signup' ? 'Already have an account? ' : 'New to Honmaru? '}<button className="link-button" disabled={busy} onClick={() => { setError(null); setMode(mode === 'signup' ? 'login' : 'signup') }}>{mode === 'signup' ? 'Sign in' : 'Create an account'}</button></p>
        </div>
        <p className="login-footnote"><Icon name="lock" size={14} /> Your team. Your decisions. One shared space.</p>
      </section>
    </main>
  )
}

export default App
