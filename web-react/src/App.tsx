import React, { useEffect, useRef, useState } from 'react'
import { ArrowRight, CheckCheck, FlaskConical, LogOut } from 'lucide-react'
import { Dashboard } from './components/Dashboard'
import { DemoWorkspace } from './components/DemoWorkspace'
import { BrandMark } from './components/Icon'
import { disableWebPush } from './utils/push'
import { apiBase, readResponse } from './utils/api'
import './App.css'
const HTTP_BASE = apiBase(import.meta.env.VITE_API_HOST, window.location, import.meta.env.DEV)
function App() {
  const [demo, setDemo] = useState(() => new URLSearchParams(location.search).get('demo') === 'true')
  const [userId, setUserId] = useState<string | null>(null), [orgId, setOrgId] = useState(''), [sessionToken, setSessionToken] = useState('')
  const [mode, setMode] = useState<'login' | 'signup'>('login'), [email, setEmail] = useState(''), [password, setPassword] = useState(''), [name, setName] = useState(''), [inviteCode, setInviteCode] = useState('')
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null)
  useEffect(() => { try { const token = localStorage.getItem('sessionToken'), user = localStorage.getItem('userId'), org = localStorage.getItem('orgId'), savedApi = localStorage.getItem('apiBase'); if (token && user && savedApi === HTTP_BASE) { setSessionToken(token); setUserId(user); setOrgId(org || '') } } catch {} }, [])
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault(); if (busy) return; setBusy(true); setError(null)
    try {
      const body = { email: email.trim(), password, ...(mode === 'signup' ? { name: name.trim(), ...(inviteCode.trim() ? { inviteCode: inviteCode.trim() } : {}) } : {}) }
      const data = await readResponse(await fetch(`${HTTP_BASE}/auth/${mode}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }))
      const uid = data.login || data.userId
      if (!data.token || !uid) throw new Error('Sign-in could not be completed. Please try again.')
      setSessionToken(data.token); setUserId(uid); setOrgId(data.orgId || ''); setPassword('')
      try { localStorage.setItem('sessionToken', data.token); localStorage.setItem('userId', uid); localStorage.setItem('orgId', data.orgId || ''); localStorage.setItem('apiBase', HTTP_BASE) } catch {}
    } catch (e) { setError(e instanceof TypeError ? 'Unable to reach Honmaru. Check your connection and try again.' : e instanceof Error ? e.message : 'Sign-in failed. Please try again.') }
    finally { setBusy(false) }
  }
  const logout = (reason?: string) => { disableWebPush(HTTP_BASE, sessionToken).catch(() => {}); setUserId(null); setSessionToken(''); setPassword(''); setError(reason || null); history.replaceState(null, '', location.pathname); try { ['sessionToken', 'userId', 'orgId'].forEach((key) => localStorage.removeItem(key)) } catch {} }
  const switchOrg = (org: string) => { setOrgId(org); history.replaceState(null, '', location.pathname); try { localStorage.setItem('orgId', org) } catch {} }
  if (demo) return <DemoWorkspace onExit={() => { setDemo(false); history.replaceState(null, '', location.pathname) }} />
  if (userId && !orgId) return <JoinWorkspace key={sessionToken} token={sessionToken} onJoined={switchOrg} onLogout={() => logout()} />
  if (userId) return <Dashboard key={`${HTTP_BASE}:${userId}:${orgId}:${sessionToken}`} userId={userId} orgId={orgId} relayUrl={HTTP_BASE.replace(/^http/, 'ws')} sessionToken={sessionToken} onLogout={logout} onSwitchOrg={switchOrg} />
  return <main className="auth-page"><header className="auth-brand"><BrandMark /><span>Honmaru<span>AI</span></span></header><section className="auth-card"><div className="auth-heading"><span className="auth-purpose"><CheckCheck size={17} />Requests, decisions, and the context behind them</span><h1>{mode === 'login' ? 'Sign in to your workspace' : 'Create your account'}</h1><p>{mode === 'login' ? 'Review incoming requests and keep your team moving.' : 'Start a workspace or join your team with an invite code.'}</p></div><form onSubmit={handleSubmit}>{mode === 'signup' && <label>Full name<input autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Alex Morgan" required maxLength={100} disabled={busy} /></label>}<label>Email address<input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" required disabled={busy} /></label><label>Password<input type="password" autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} value={password} onChange={(e) => setPassword(e.target.value)} placeholder={mode === 'signup' ? 'At least 8 characters' : 'Your password'} required minLength={mode === 'signup' ? 8 : undefined} disabled={busy} /></label>{mode === 'signup' && <label>Team invite code <span>Optional</span><input value={inviteCode} onChange={(e) => setInviteCode(e.target.value)} placeholder="Paste your team’s code" autoComplete="off" disabled={busy} /><small>Leave blank to start your own workspace.</small></label>}{error && <div className="form-error" role="alert">{error}</div>}<button className="primary-button auth-submit" disabled={busy}>{busy ? 'Connecting…' : mode === 'login' ? 'Sign in' : 'Create account'}{!busy && <ArrowRight size={16} />}</button></form><p className="auth-switch">{mode === 'login' ? 'New to Honmaru?' : 'Already have an account?'}<button disabled={busy} onClick={() => { setError(null); setMode(mode === 'login' ? 'signup' : 'login') }}>{mode === 'login' ? 'Create an account' : 'Sign in'}</button></p></section><section className="auth-demo"><span><FlaskConical size={20} /></span><div><strong>Explore a sample workspace</strong><p>Try reviewing, responding, and creating a request. No account needed. Sample data stays in your browser.</p><button onClick={() => { history.replaceState(null, '', '?demo=true'); setDemo(true) }}>Try the local demo <ArrowRight size={14} /></button></div></section><footer className="auth-footer">Built for clear requests and considered decisions.</footer></main>
}
function JoinWorkspace({ token, onJoined, onLogout }: { token: string; onJoined: (org: string) => void; onLogout: () => void }) {
  const [code, setCode] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState(''); const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  return <main className="auth-page"><header className="auth-brand"><BrandMark /><span>Honmaru AI</span></header><section className="auth-card"><div className="auth-heading"><h1>Join your team’s workspace</h1><p>You’re signed in. Ask a teammate for an invite code to restore workspace access.</p></div><form onSubmit={async (e) => { e.preventDefault(); if (busy) return; setBusy(true); setError(''); try { const data = await readResponse(await fetch(`${HTTP_BASE}/invites/accept`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-session-token': token }, body: JSON.stringify({ code: code.trim() }) })); if (alive.current && data.orgId) onJoined(data.orgId) } catch (e) { if (alive.current) setError(e instanceof Error ? e.message : 'Could not join workspace.') } finally { if (alive.current) setBusy(false) } }}><label>Invite code<input value={code} onChange={(e) => setCode(e.target.value)} required autoComplete="off" /></label>{error && <div className="form-error" role="alert">{error}</div>}<button disabled={busy || !code.trim()} className="primary-button auth-submit">{busy ? 'Joining…' : 'Join workspace'}<ArrowRight size={16} /></button></form><button className="auth-signout" onClick={onLogout}><LogOut size={15} />Sign out</button></section></main>
}
export default App
