import React, { useEffect, useRef, useState } from 'react'
import { Bell, ChevronDown, ChevronLeft, ChevronRight, Crown, Globe2, History, LogOut, Settings2, Sparkles, UserRound } from 'lucide-react'
import { getLocale, LOCALE_NAMES } from '../utils/locale'
import type { Business } from '../types/card'
import { useT, changeLocale as applyLocale } from '../utils/i18n'
import './ProfileFigma.css'

interface Props {
  sample?: boolean
  sampleMembers?: Array<{id:string;name:string;role:string}>
  onResetSample?: () => void
  httpBase: string
  orgId: string
  userId: string
  sessionToken: string
  businesses: Business[]
  pendingCount: number
  decidedCount: number
  onOpen: (screen: 'tools' | 'notifications' | 'history' | 'plans' | 'record' | 'invite') => void
  onLocaleChange: () => void
  onLogout: () => void
  onClose: () => void
}
interface Me {
  name: string
  login: string
  email: string | null
  locale: string
  role: string | null
  assignableRoles: string[]
}
interface AIState { aiRouting: boolean; aiModel: string }
interface PlanState { plan: string; pro: boolean }

const ROLE_LABEL: Record<string, string> = {
  founder: 'Founder / operator', operator: 'Ops / business', engineer: 'Engineer',
  designer: 'Designer', member: 'Member', admin: 'Admin', maintainer: 'Maintainer', triager: 'Triager',
}

export const Profile: React.FC<Props> = ({ httpBase, orgId, userId, sessionToken, onOpen, onLocaleChange, onLogout, onClose, sample = false, sampleMembers = [], onResetSample }) => {
  const t = useT()
  const [me, setMe] = useState<Me | null>(null)
  const [ai, setAI] = useState<AIState | null | undefined>(undefined)
  const [plan, setPlan] = useState<PlanState | null>(null)
  const [locale, setLocaleState] = useState(getLocale())
  const [error, setError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [saving, setSaving] = useState<'role' | 'locale' | 'delete' | null>(null)
  const [sampleNotifications,setSampleNotifications] = useState(false)
  const [aiOpen, setAIOpen] = useState(false)
  const scope = useRef(0)

  useEffect(() => {
    if (sample) { setMe({name:'Alex Morgan',login:userId,email:null,locale:getLocale(),role:'Product lead',assignableRoles:[]});setAI(null);setPlan(null);return }
    const version = ++scope.current
    const controller = new AbortController()
    setMe(null); setAI(undefined); setPlan(null); setError(null)
    setSaving(null); setConfirmDelete(false); setAIOpen(false)
    const read = async (path: string) => {
      const response = await fetch(`${httpBase}${path}`, { headers: { 'x-session-token': sessionToken }, signal: controller.signal })
      if (!response.ok) throw new Error(t('Could not read your profile.'))
      return response.json()
    }
    void read(`/me?orgId=${encodeURIComponent(orgId)}`).then((data: Me) => {
      if (scope.current !== version) return
      setMe(data)
      if (data.locale) setLocaleState(data.locale)
    }).catch(() => { if (!controller.signal.aborted) setError(t('Could not read your profile.')) })
    void read('/health').then((data: AIState) => { if (scope.current === version) setAI(data) })
      .catch(() => { if (scope.current === version) setAI(null) })
    void read('/billing/status').then((data: PlanState) => { if (scope.current === version) setPlan(data) }).catch(() => {})
    return () => { scope.current += 1; controller.abort() }
  }, [httpBase, orgId, userId, sessionToken])

  const patch = async (body: Record<string, unknown>, field: 'role' | 'locale') => {
    if (saving) return
    if (sample) { if (field === 'locale' && typeof body.locale === 'string') { setLocaleState(body.locale); applyLocale(body.locale);onLocaleChange() }; return }
    const version = scope.current
    setSaving(field); setError(null)
    try {
      const res = await fetch(`${httpBase}/me`, {
        method: 'PUT', headers: { 'content-type': 'application/json', 'x-session-token': sessionToken }, body: JSON.stringify(body),
      })
      const data = await res.json().catch(() => ({}))
      if (scope.current !== version) return
      if (!res.ok) { setError(data.message || t('That did not save.')); return }
      setMe((previous) => previous ? { ...previous, ...data } : previous)
      if (field === 'locale' && typeof data.locale === 'string') {
        setLocaleState(data.locale); applyLocale(data.locale); onLocaleChange()
      }
    } catch {
      if (scope.current === version) setError(t('That did not save.'))
    } finally {
      if (scope.current === version) setSaving(null)
    }
  }

  const deleteAccount = async () => {
    if (saving) return
    const version = scope.current
    setSaving('delete'); setError(null)
    try {
      const res = await fetch(`${httpBase}/account`, { method: 'DELETE', headers: { 'x-session-token': sessionToken } })
      if (scope.current !== version) return
      if (res.ok) onLogout()
      else setError(t('That did not work. Try again in a moment.'))
    } catch {
      if (scope.current === version) setError(t('That did not work. Try again in a moment.'))
    } finally {
      if (scope.current === version) setSaving(null)
    }
  }

  const handle = (me?.login || userId).replace(/^(u:|email:)/, '')
  const display = me?.name || handle.split('@')[0]
  const model = sample ? t('Local sample') : ai ? (ai.aiRouting ? ai.aiModel : t('Keyword routing')) : t(ai === undefined ? 'Loading…' : 'Unavailable')
  const role = me?.role ? t(ROLE_LABEL[me.role] || me.role) : t('Your workspace')
  const roles = me?.assignableRoles || []

  return (
    <section className="screen figma-profile" aria-label={t('Profile')}>
      <header className="figma-profile-header">
        <button type="button" className="figma-profile-back" onClick={onClose} aria-label={t('Close')}><ChevronLeft size={21} /></button>
        <h1>{t('Profile')}</h1>
      </header>
      <div className="figma-profile-body">
        <section className="figma-profile-identity">
          <div className="figma-profile-person">
            <span className="figma-profile-avatar" aria-hidden="true"><UserRound size={25} strokeWidth={1.6} /></span>
            <div><h2>{display}</h2><p>{role}{me?.role && <> <span aria-hidden="true">·</span> {t(sample ? 'Sample workspace' : 'Your workspace')}</>}</p></div>
          </div>
          <button type="button" className="figma-profile-assistant" onClick={() => setAIOpen(!aiOpen)} aria-expanded={aiOpen} aria-controls="profile-ai-details">
            <span className="figma-profile-assistant-icon"><Sparkles size={20} strokeWidth={1.6} /></span>
            <span className="figma-profile-assistant-copy"><b>{model}</b><small>{t(sample ? 'Sample workspace · local only' : 'Your AI assistant')}</small></span>
            {ai?.aiRouting ? <span className="figma-profile-status">{t('Configured')}</span> : <ChevronRight size={17} />}
          </button>
        </section>
        {error && <div className="form-error" role="alert">{error}</div>}
        <section className="figma-profile-group" aria-label={t('How your AI treats you')}>
          <details className="figma-profile-ai" open={aiOpen} onToggle={(event) => setAIOpen(event.currentTarget.open)}>
            <summary className="figma-profile-row"><Sparkles /><span>{t('AI')}</span><ChevronRight className="figma-profile-chevron" /></summary>
            <div id="profile-ai-details" className="figma-profile-disclosure">
              <b>{model}</b>{sample && <p>{t('Changes stay in this browser. No messages or notifications are sent.')}</p>}{ai && <p>{t(ai.aiRouting ? 'The AI model is configured by your workspace.' : 'This deployment uses keyword routing.')}</p>}
              <button type="button" disabled={sample} onClick={() => onOpen('tools')}>{t('Tools')}<ChevronRight size={16} /></button>
            </div>
          </details>
          <label className="figma-profile-row figma-profile-language"><Globe2 /><span>{t('Language')}</span>
            <select value={locale} onChange={(event) => void patch({ locale: event.target.value }, 'locale')} aria-label={t('Language')} disabled={!me || saving !== null}>
              {Object.entries(LOCALE_NAMES).map(([code, label]) => <option key={code} value={code}>{label}</option>)}
            </select><ChevronRight className="figma-profile-chevron" />
          </label>
          <button type="button" className="figma-profile-row" onClick={() => sample ? setSampleNotifications(!sampleNotifications) : onOpen('notifications')}><Bell /><span>{t('Notifications')}</span><ChevronRight className="figma-profile-chevron" /></button>
          <button type="button" className="figma-profile-row" onClick={() => onOpen('history')}><History /><span>{t('History')}</span><ChevronRight className="figma-profile-chevron" /></button>
        </section>
        {sample && sampleNotifications && <p className="form-note" role="status">{t('Changes stay in this browser. No messages or notifications are sent.')}</p>}
        <section className="figma-profile-group figma-profile-plan-group" aria-label={t('Plan')}>
          <button type="button" className="figma-profile-plan" disabled={sample} onClick={() => onOpen('plans')}>
            <span className="figma-profile-plan-icon"><Crown size={19} /></span>
            <span><b>{sample ? t('Sample workspace') : plan ? (plan.pro ? 'Pro' : t('Free')) : t('Plan')}</b><small>{t(sample ? 'Sign in to manage billing.' : 'Choose your plan')}</small></span>
            <ChevronRight className="figma-profile-chevron" />
          </button>
          <button type="button" className="figma-profile-row" onClick={onLogout}><LogOut /><span>{t(sample ? 'Exit demo' : 'Sign out')}</span></button>
        </section>
        <details className="figma-profile-account">
          <summary><Settings2 size={17} /><span>{t(sample ? 'Sample workspace' : 'Account')}</span><ChevronDown size={16} /></summary>
          <div className="figma-profile-account-body">{sample ? <>{sampleMembers.map(member => <p key={member.id}>{member.name}{member.id === userId ? ` (${t('You')})` : ''}<br /><span className="figma-profile-hint">{t(member.role)}</span></p>)}<button type="button" onClick={onResetSample}>{t('Reset demo')}</button></> : <>
            <p className="figma-profile-email">{me?.email || handle}</p>
            <label className="figma-profile-role"><span>{t('Role')}</span>
              <select value={me?.role || ''} onChange={(event) => void patch({ role: event.target.value, orgId }, 'role')} aria-label={t('Role')} disabled={!me || !roles.length || saving !== null}>
                {!roles.includes(me?.role || '') && <option value={me?.role || ''} disabled>{me?.role ? role : t('Loading…')}</option>}
                {roles.map((value) => <option key={value} value={value}>{t(ROLE_LABEL[value] || value)}</option>)}
              </select>
            </label>
            <p className="figma-profile-hint">{t('What gets routed to you first.')}</p>
            <button type="button" disabled={sample} onClick={() => onOpen('tools')}>{t('Tools')}<ChevronRight size={16} /></button>
            <button type="button" onClick={() => onOpen('record')}>{t('The record')}<ChevronRight size={16} /></button>
            <button type="button" onClick={() => onOpen('invite')}>{t('Invite a teammate')}<ChevronRight size={16} /></button>
            <button type="button" className="figma-profile-delete" onClick={() => setConfirmDelete(true)}>{t('Delete account')}</button>
            {confirmDelete && <div className="figma-profile-confirm" role="alert">
              <p>{t('This removes your account and your cards. Decisions other people made stay in their record.')}</p>
              <div><button type="button" onClick={() => setConfirmDelete(false)} disabled={saving === 'delete'}>{t('Keep it')}</button><button type="button" onClick={() => void deleteAccount()} disabled={saving === 'delete'}>{saving === 'delete' ? t('Loading…') : t('Delete')}</button></div>
            </div>}
          </>} </div>
        </details>
      </div>
    </section>
  )
}
