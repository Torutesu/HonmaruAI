import { forgetMembers } from '../utils/mentions'
import React, { useEffect, useRef, useState } from 'react'
import { getLocale, primary } from '../utils/locale'
import { LanguageOptions } from '../components/LanguageOptions'
import type { Business } from '../types/card'
import { useT, changeLocale as applyLocale } from '../utils/i18n'
import { Icon } from '../components/Icon'
import { Avatar } from '../components/Avatar'
import { getSenderContext, setSenderContext, loadSenderContext, saveSenderContext, MAX_CONTEXT_CHARS } from '../utils/context'
import { canInstall, promptInstall, onInstallChange } from '../utils/install'
import { getAIKey, setAIKey } from '../utils/aiKey'

interface Props {
  httpBase: string
  orgId: string
  userId: string
  sessionToken: string
  businesses: Business[]
  pendingCount: number
  decidedCount: number
  onOpen: (screen: 'tools' | 'notifications' | 'history' | 'plans' | 'record' | 'team' | 'insights' | 'automations' | 'playbook') => void
  onLocaleChange: () => void
  onSwitchOrg: (orgId: string) => void
  onLogout: () => void
  onClose: () => void
}

/// One workspace this person belongs to. `founder` stands in for a name a
/// workspace made at sign-up does not have — `personal:8f3a…` is an id, not
/// something to put on a screen.
interface Org {
  id: string
  role: string
  name: string | null
  founder: string | null
  mine: boolean
}

interface Me {
  avatarUrl?: string | null
  name: string
  login: string
  email: string | null
  locale: string
  role: string | null
  assignableRoles: string[]
  aliases?: string[]
  /// The username @ finds you by; null until you choose one.
  handle?: string | null
  orgs?: Org[]
}

// English keys, translated where they are read — see utils/i18n.
const ROLE_LABEL: Record<string, string> = {
  founder: 'Founder / operator', operator: 'Ops / business',
  engineer: 'Engineer', designer: 'Designer', member: 'Member',
  admin: 'Admin', maintainer: 'Maintainer', triager: 'Triager',
}

/// You: who your AI thinks you are, what it has done for you, and the way out.
export const Profile: React.FC<Props> = ({
  httpBase, orgId, userId, sessionToken, businesses, pendingCount, decidedCount,
  onOpen, onLocaleChange, onSwitchOrg, onLogout, onClose,
}) => {
  const t = useT()
  const [me, setMe] = useState<Me | null>(null)
  const [locale, setLocaleState] = useState(getLocale())
  const [error, setError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  // Redeeming a code from inside the app. Until this existed, an invite only
  // worked on the day you made your account: the sign-in screen took a code,
  // and nothing anywhere took one from a person who was already signed in.
  const [joining, setJoining] = useState(false)
  const [joinCode, setJoinCode] = useState('')
  const [joinError, setJoinError] = useState<string | null>(null)
  // Starting a team of your own — a second business, a client, a project —
  // with a name on the door from the first day.
  const [creating, setCreating] = useState(false)
  const [teamName, setTeamName] = useState('')
  const [createError, setCreateError] = useState<string | null>(null)
  const [createBusy, setCreateBusy] = useState(false)
  // What else people call you, as one comma-separated line. The router
  // matches an instruction against these, so 「美香に」 reaches an account
  // whose login is "mika".
  const [aliases, setAliases] = useState('')
  // What you do, in your own words — typed, then saved when you leave the box.
  const [roleDraft, setRoleDraft] = useState<string | null>(null)
  // "How I work": stored on the server per person and per workspace, sent
  // with every instruction. The local copy shows first; the server's replaces
  // it unless you have already started typing.
  const [howIWork, setHowIWork] = useState(() => getSenderContext(orgId))
  const howTouched = useRef(false)
  const howSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [howSaved, setHowSaved] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle')
  useEffect(() => {
    let ignore = false
    loadSenderContext(httpBase, orgId, sessionToken).then((text) => {
      if (ignore || text === null || howTouched.current) return
      setHowIWork(text)
    })
    return () => { ignore = true }
  }, [httpBase, orgId, sessionToken])
  const howPending = useRef<string | null>(null)
  const flushHow = async () => {
    if (howSaveTimer.current) { clearTimeout(howSaveTimer.current); howSaveTimer.current = null }
    const text = howPending.current
    if (text === null) return
    howPending.current = null
    const ok = await saveSenderContext(httpBase, orgId, sessionToken, text)
    setHowSaved(ok ? 'saved' : 'failed')
  }
  const saveHow = (text: string) => {
    if (howSaveTimer.current) clearTimeout(howSaveTimer.current)
    howPending.current = text
    setHowSaved('saving')
    howSaveTimer.current = setTimeout(() => { void flushHow() }, 600)
  }
  // Leaving the screen, or the page, must not lose what was typed.
  useEffect(() => {
    const onHide = () => { void flushHow() }
    window.addEventListener('pagehide', onHide)
    return () => { window.removeEventListener('pagehide', onHide); void flushHow() }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // Your own model key, kept in this browser, sent only with your requests.
  const [aiKey, setAIKeyState] = useState(getAIKey)
  const [keySaved, setKeySaved] = useState(false)
  const [installable, setInstallable] = useState(canInstall)
  useEffect(() => onInstallChange(() => setInstallable(canInstall())), [])
  // Typed before the profile arrived: the fetch must not overwrite it. That
  // race is exactly what the end-to-end suite hit on a fast machine.
  const aliasesTouched = useRef(false)
  // What this screen saved, as the Worker answered: a profile read that set
  // out before the save must not put the old values back.
  const savedHere = useRef<Record<string, unknown>>({})
  // Your name and username, as you are typing them, and what the Worker
  // said about the username — taken, reserved, or the wrong shape.
  const [nameDraft, setNameDraft] = useState<string | null>(null)
  const [handleDraft, setHandleDraft] = useState<string | null>(null)
  const [handleNote, setHandleNote] = useState<{ ok: boolean; text: string } | null>(null)
  const saveIdentity = async (body: { name?: string; handle?: string }) => {
    const res = await fetch(`${httpBase}/me`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-session-token': sessionToken },
      body: JSON.stringify(body),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      if (data.field === 'handle') setHandleNote({ ok: false, text: data.message || t('That username cannot be used.') })
      else setError(data.message || t('That did not save.'))
      return false
    }
    setError(null)
    savedHere.current = { ...savedHere.current, ...(data.name ? { name: data.name } : {}), handle: data.handle ?? null }
    setMe((prev) => (prev ? { ...prev, name: data.name ?? prev.name, handle: data.handle ?? null } : prev))
    // Everyone's @ list is cached per workspace; yours has just changed.
    forgetMembers()
    if (body.handle !== undefined) setHandleNote(data.handle ? { ok: true, text: t('Saved. Teammates can write @{handle}.', { handle: data.handle }) } : null)
    return true
  }

  /// Your own photo: square-cropped and shrunk in the browser, then sent as
  /// the image itself. Everyone sees it beside what you write.
  const uploadPhoto = async (file: File) => {
    setError(null)
    try {
      const blob = await squareImage(file, 256)
      const res = await fetch(`${httpBase}/me/avatar`, { method: 'POST', headers: { 'x-session-token': sessionToken, 'content-type': blob.type }, body: blob })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setError(data.message || t('That did not save.')); return }
      setMe((prev) => (prev ? { ...prev, avatarUrl: data.avatarUrl } : prev))
      forgetMembers()
      window.dispatchEvent(new CustomEvent('honmaru:workspace'))
    } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
  }

  useEffect(() => {
    fetch(`${httpBase}/me?orgId=${encodeURIComponent(orgId)}`, { headers: { 'x-session-token': sessionToken } })
      .then((r) => r.json())
      .then((data) => {
        setMe({ ...data, ...savedHere.current })
        if (data.locale) setLocaleState(data.locale)
        if (!aliasesTouched.current) setAliases((data.aliases || []).join(', '))
      })
      .catch(() => setError(t('Could not read your profile.')))
  }, [httpBase, orgId, sessionToken])

  const patch = async (body: Record<string, unknown>) => {
    const res = await fetch(`${httpBase}/me`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-session-token': sessionToken },
      body: JSON.stringify(body),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) { setError(data.message || t('That did not save.')); return }
    setError(null)
    savedHere.current = { ...savedHere.current, ...data }
    setMe((prev) => (prev ? { ...prev, ...data } : prev))
  }

  const changeLocale = (code: string) => {
    setLocaleState(code)
    // Through i18n, not straight to storage: it is what repaints the interface.
    // Writing the preference alone changed the notifications and left every
    // label on the screen in English, which reads as a setting that does not work.
    applyLocale(code)
    patch({ locale: code })
    onLocaleChange()
  }

  const join = async () => {
    setJoinError(null)
    const code = joinCode.trim()
    if (!code) return
    try {
      const res = await fetch(`${httpBase}/invites/accept`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-session-token': sessionToken },
        body: JSON.stringify({ code }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setJoinError(data.message || t('That invite code is not valid.')); return }
      setJoinCode('')
      setJoining(false)
      onSwitchOrg(data.orgId)
    } catch (err) {
      setJoinError(err instanceof Error ? err.message : String(err))
    }
  }

  const createTeam = async () => {
    setCreateError(null)
    const name = teamName.trim()
    if (!name) return
    setCreateBusy(true)
    try {
      const res = await fetch(`${httpBase}/orgs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-session-token': sessionToken },
        body: JSON.stringify({ name }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setCreateError(data.message || t('That did not save.')); return }
      setTeamName('')
      setCreating(false)
      onSwitchOrg(data.orgId)
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : String(err))
    } finally { setCreateBusy(false) }
  }

  /// What to call a workspace. A repository org is already readable; one made
  /// at sign-up is `personal:<hash>`, so whoever started it stands in for a
  /// name — "yours", or "Dana's team".
  const orgLabel = (org: Org) => {
    if (org.name) return org.name
    if (org.id.includes('/')) return org.id
    if (org.mine) return t('Your workspace')
    return org.founder ? t("{name}'s team", { name: org.founder }) : t('A team you joined')
  }

  const deleteAccount = async () => {
    const res = await fetch(`${httpBase}/account`, {
      method: 'DELETE',
      headers: { 'x-session-token': sessionToken },
    })
    if (res.ok) onLogout()
    else setError(t('That did not work. Try again in a moment.'))
  }

  const handle = (me?.login || userId).replace(/^(u:|email:)/, '')
  const display = me?.name || handle.split('@')[0]

  return (
    <div className="screen screen-wide profile-screen">
      <div className="screen-head">
        <button className="back" onClick={onClose} aria-label={t('Close')}>‹</button>
        <span className="head-title">{t('You')}</span>
      </div>
      <div className="screen-body">
        <div className="profile-layout">
        <aside className="profile-side">
          <section className="pf-sec pf-head">
          <div className="profile-head">
            <label className="profile-avatar-edit" title={t('Change your photo')}>
              <Avatar name={display || '?'} url={me?.avatarUrl} size={56} className="profile-avatar-face" />
              <span className="profile-avatar-cta" aria-hidden="true"><Icon name="edit" size={12} /></span>
              <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" className="sr-only" aria-label={t('Change your photo')}
                onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void uploadPhoto(f) }} data-avatar-input="1" />
            </label>
            <div>
              <b>{display}</b>
              <span>{me?.handle ? `@${me.handle}` : ''}{me?.handle && (me?.email || handle) ? ' · ' : ''}{me?.email || handle}</span>
            </div>
          </div>

          </section>
          <section className="pf-sec pf-stats">
          <div className="profile-stats">
            <div><b>{pendingCount}</b><span>{t('waiting')}</span></div>
            <div><b>{decidedCount}</b><span>{t('decided')}</span></div>
            <div><b>{businesses.length}</b><span>{t('businesses')}</span></div>
          </div>

          </section>
          <section className="pf-sec pf-ws">
          <div className="rows-title">{t('Your workspace')}</div>
          <div className="rows">
            <button className="row" onClick={() => onOpen('history')}>
              <span className="row-icon"><Icon name="history" size={18} /></span>
              <span className="row-main">{t('History')}<span className="row-sub">{t('Everything already settled.')}</span></span>
              <span className="row-value">›</span>
            </button>
            <button className="row" onClick={() => onOpen('insights')}>
              <span className="row-icon"><Icon name="insights" size={18} /></span>
              <span className="row-main">{t('Insights')}<span className="row-sub">{t('How long decisions wait, what gets declined, what your AI got wrong.')}</span></span>
              <span className="row-value">›</span>
            </button>
            <button className="row" onClick={() => onOpen('automations')}>
              <span className="row-icon"><Icon name="repeat" size={18} /></span>
              <span className="row-main">{t('Automations')}<span className="row-sub">{t('Work your AI does on a schedule, delivered to your feed as a card.')}</span></span>
              <span className="row-value">›</span>
            </button>
            <button className="row" onClick={() => onOpen('playbook')}>
              <span className="row-icon"><Icon name="book" size={18} /></span>
              <span className="row-main">{t('Playbook')}<span className="row-sub">{t('The rules your AI has learned from your decisions, and the ones you told it.')}</span></span>
              <span className="row-value">›</span>
            </button>
            <button className="row" onClick={() => onOpen('record')}>
              <span className="row-icon"><Icon name="record" size={18} /></span>
              <span className="row-main">{t('The record')}<span className="row-sub">{t('Every decision, by business, written by nobody.')}</span></span>
              <span className="row-value">›</span>
            </button>
            <button className="row" onClick={() => onOpen('tools')}>
              <span className="row-icon"><Icon name="tools" size={18} /></span>
              <span className="row-main">{t('Tools')}<span className="row-sub">{t('Gmail, Slack, Notion, GitHub.')}</span></span>
              <span className="row-value">›</span>
            </button>
            {installable && (
              <button className="row" onClick={() => promptInstall()}>
                <span className="row-main">{t('Install the app')}<span className="row-sub">{t('On your desktop or home screen, and it opens offline.')}</span></span>
                <span className="row-chevron">›</span>
              </button>
            )}
            <button className="row" onClick={() => onOpen('notifications')}>
              <span className="row-icon"><Icon name="bell" size={18} /></span>
              <span className="row-main">{t('Notifications')}<span className="row-sub">{t('Where a decision reaches you.')}</span></span>
              <span className="row-value">›</span>
            </button>
            <button className="row" onClick={() => onOpen('team')}>
              <span className="row-icon"><Icon name="invite" size={18} /></span>
              <span className="row-main">{t('Your team')}<span className="row-sub">{t('Who is here, the links you have out, and one more way in.')}</span></span>
              <span className="row-value">›</span>
            </button>
            <button className="row join-team" onClick={() => { setJoining(!joining); setJoinError(null) }}>
              <span className="row-icon"><Icon name="invite" size={18} /></span>
              <span className="row-main">{t('Join a team')}<span className="row-sub">{t('Paste the invite link somebody sent you.')}</span></span>
              <span className="row-value">{joining ? '⌄' : '›'}</span>
            </button>
            {joining && (
              <div className="row static">
                <input
                  className="join-code"
                  value={joinCode}
                  onChange={(e) => setJoinCode(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') join() }}
                  placeholder={t('Invite link')}
                  aria-label={t('Invite link')}
                />
                <button className="pill-btn" onClick={join} disabled={!joinCode.trim()}>{t('Join')}</button>
              </div>
            )}
            {joinError && <div className="form-error">{joinError}</div>}
            <button className="row create-team" onClick={() => { setCreating(!creating); setCreateError(null) }}>
              <span className="row-icon"><Icon name="invite" size={18} /></span>
              <span className="row-main">{t('Create a team')}<span className="row-sub">{t('A workspace of its own, with a name, that you invite people into.')}</span></span>
              <span className="row-value">{creating ? '⌄' : '›'}</span>
            </button>
            {creating && (
              <div className="row static">
                <input
                  className="team-name-input"
                  value={teamName}
                  onChange={(e) => setTeamName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') createTeam() }}
                  placeholder={t('Team name')}
                  aria-label={t('Team name')}
                  maxLength={60}
                />
                <button className="pill-btn" onClick={createTeam} disabled={createBusy || !teamName.trim()}>{t('Create')}</button>
              </div>
            )}
            {createError && <div className="form-error">{createError}</div>}
            <button className="row" onClick={() => onOpen('plans')}>
              <span className="row-icon"><Icon name="plan" size={18} /></span>
              <span className="row-main">{t('Plan')}<span className="row-sub">{t('What you are on, and what else there is.')}</span></span>
              <span className="row-value">›</span>
            </button>
          </div>

          </section>
        </aside>
        <div className="profile-main">
          <section className="pf-sec pf-err">
          {error && <div className="form-error">{error}</div>}

          </section>
          <section className="pf-sec pf-profile">
          <div className="rows-title">{t('Profile')}</div>
          <div className="rows">
            <div className="row static">
              <span className="row-main">
                {t('Name')}
                <span className="row-sub">{t('What teammates see on cards, in channels and in the list.')}</span>
                <input
                  className="alias-input name-input"
                  value={nameDraft ?? (me?.name || '')}
                  maxLength={60}
                  onChange={(e) => setNameDraft(e.target.value)}
                  onBlur={() => {
                    const next = (nameDraft ?? '').trim()
                    if (nameDraft !== null && next && next !== me?.name) void saveIdentity({ name: next })
                    setNameDraft(null)
                  }}
                  onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
                  placeholder={t('e.g. Toru Tano')}
                  aria-label={t('Name')}
                />
              </span>
            </div>
            <div className="row static">
              <span className="row-main">
                {t('Username')}
                <span className="row-sub">{t('What @ finds you by — in a channel, on a card, when you tell your AI. Letters, numbers, “.”, “_” and “-”.')}</span>
                <span className="handle-field">
                  <span className="handle-at" aria-hidden="true">@</span>
                  <input
                    className="alias-input handle-input"
                    value={handleDraft ?? (me?.handle || '')}
                    maxLength={30}
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    onChange={(e) => { setHandleDraft(e.target.value.replace(/^@/, '').toLowerCase()); setHandleNote(null) }}
                    onBlur={async () => {
                      if (handleDraft === null) return
                      const next = handleDraft.trim()
                      if (next !== (me?.handle || '')) {
                        if (await saveIdentity({ handle: next })) setHandleDraft(null)
                      } else setHandleDraft(null)
                    }}
                    onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
                    placeholder={t('e.g. toru')}
                    aria-label={t('Username')}
                    aria-invalid={handleNote ? !handleNote.ok : undefined}
                  />
                </span>
                {handleNote && <span className={`row-sub handle-note${handleNote.ok ? ' ok' : ' bad'}`} role="status">{handleNote.text}</span>}
              </span>
            </div>
          </div>

          </section>
          <section className="pf-sec pf-ai">
          <div className="rows-title">{t('How your AI treats you')}</div>
          <div className="rows">
            <div className="row static">
              <span className="row-main">
                {t('Role')}
                <span className="row-sub">{t('What gets routed to you first. In your own words — anyone can change theirs.')}</span>
              </span>
              {me ? (
                <span className="row-main role-edit">
                  <input
                    className="role-input"
                    list="role-presets"
                    value={roleDraft ?? (me.role ? (ROLE_LABEL[me.role] ? t(ROLE_LABEL[me.role]) : me.role) : '')}
                    maxLength={40}
                    onChange={(e) => setRoleDraft(e.target.value)}
                    onBlur={() => { if (roleDraft !== null && roleDraft.trim() && roleDraft.trim() !== me.role) patch({ role: roleDraft.trim(), orgId }); setRoleDraft(null) }}
                    onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
                    placeholder={t('e.g. store manager, CFO, designer')}
                    aria-label={t('Role')}
                  />
                  <datalist id="role-presets">
                    {(me.assignableRoles || []).map((r) => <option key={r} value={r}>{t(ROLE_LABEL[r] || r)}</option>)}
                  </datalist>
                </span>
              ) : (
                <span className="row-value">—</span>
              )}
            </div>
            <div className="row static">
              <span className="row-main">
                {t('Also called')}
                <span className="row-sub">{t('Names your AI should recognise as you — a first name, a nickname, in any language.')}</span>
                <input
                  className="alias-input aliases-input"
                  value={aliases}
                  onChange={(e) => { aliasesTouched.current = true; setAliases(e.target.value) }}
                  onBlur={() => {
                    const list = aliases.split(/[,、]/).map((a) => a.trim()).filter(Boolean)
                    if (list.join(',') !== (me?.aliases || []).join(',')) patch({ aliases: list })
                  }}
                  placeholder={t('e.g. 美香, Mika')}
                  aria-label={t('Also called')}
                />
              </span>
            </div>
            <div className="row static">
              <span className="row-main">
                {t('How I work')}
                <span className="row-sub">{t('What your AI should know before it routes anything you say: what you run, who owns what, what is always yours.')}</span>
                <textarea
                  className="context-input"
                  value={howIWork}
                  rows={3}
                  maxLength={MAX_CONTEXT_CHARS}
                  onChange={(e) => { howTouched.current = true; setHowIWork(e.target.value); setSenderContext(e.target.value, orgId); saveHow(e.target.value) }}
                  onBlur={() => { void flushHow() }}
                  placeholder={t('e.g. I run the cafe and the hotel. Kenji owns suppliers. Anything about the lease is mine.')}
                  aria-label={t('How I work')}
                />
                {howSaved !== 'idle' && (
                  <span className="row-sub context-state" role="status">
                    {howSaved === 'saving' ? t('Saving…') : howSaved === 'saved' ? t('Saved to this workspace.') : t('That did not save.')}
                  </span>
                )}
              </span>
            </div>
            <div className="row static">
              <span className="row-main">
                {t('Your own AI key')}
                <span className="row-sub">{t('Use your own OpenAI key for routing, answers, drafts and translations. It stays in this browser and is sent only with your own requests — we never store it on our servers.')}</span>
                <div className="key-row">
                  <input
                    className="alias-input key-input"
                    type="password"
                    autoComplete="off"
                    value={aiKey}
                    onChange={(e) => { setAIKeyState(e.target.value); setKeySaved(false) }}
                    onBlur={() => { setAIKey(aiKey); setKeySaved(Boolean(aiKey.trim())) }}
                    placeholder="sk-…"
                    aria-label={t('Your own AI key')}
                  />
                  {aiKey && (
                    <button type="button" className="pill-btn" onClick={() => { setAIKey(''); setAIKeyState(''); setKeySaved(false) }}>{t('Clear')}</button>
                  )}
                </div>
                {keySaved && <span className="row-sub key-saved">{t('Saved in this browser.')}</span>}
              </span>
            </div>
            <div className="row static">
              <span className="row-main">
                {t('Language')}
                <span className="row-sub">{t('Every notification arrives written in it.')}</span>
              </span>
              <select className="row-select" value={primary(locale)} onChange={(e) => changeLocale(e.target.value)} aria-label={t('Language')}>
                <LanguageOptions current={locale} />
              </select>
            </div>
          </div>

          </section>
          <section className="pf-sec pf-where">
          {(me?.orgs?.length || 0) > 1 && (
            <>
              <div className="rows-title">{t('Where you work')}</div>
              <div className="rows">
                {me!.orgs!.map((org) => (
                  <button
                    key={org.id}
                    className="row"
                    data-org={org.id}
                    aria-current={org.id === orgId}
                    onClick={() => { if (org.id !== orgId) onSwitchOrg(org.id) }}
                  >
                    <span className="row-main">
                      {orgLabel(org)}
                      <span className="row-sub">{t(ROLE_LABEL[org.role] || org.role)}</span>
                    </span>
                    <span className="row-value">{org.id === orgId ? '✓' : '›'}</span>
                  </button>
                ))}
              </div>
            </>
          )}

          </section>
          <section className="pf-sec pf-biz">
          {businesses.length > 0 && (
            <>
              <div className="rows-title">{t('Businesses your AI has found')}</div>
              <div className="chips">
                {businesses.map((b) => <span key={b.slug} className="pill-tag">{b.name}</span>)}
              </div>
              <p className="hint" style={{ margin: '8px 4px 20px', color: 'var(--ash)', fontSize: 12.5 }}>
                {t('businesses.blurb')}
              </p>
            </>
          )}

          </section>
          <section className="pf-sec pf-acct">
          <div className="rows">
            <button className="row" onClick={onLogout}>
              <span className="row-main" style={{ color: 'var(--slate)' }}>{t('Sign out')}</span>
            </button>
            <button className="row" onClick={() => setConfirmDelete(true)}>
              <span className="row-main" style={{ color: '#a11258' }}>{t('Delete account')}</span>
            </button>
          </div>

          {confirmDelete && (
            <div className="form-error">
              {t('delete.body')}
              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                <button className="btn btn-ghost" onClick={() => setConfirmDelete(false)}>{t('Keep it')}</button>
                <button className="btn btn-primary" onClick={deleteAccount}>{t('Delete')}</button>
              </div>
            </div>
          )}
          </section>
        </div>
        </div>
        <div style={{ height: 32 }} />
      </div>
    </div>
  )
}

/// An image, cropped to its centre square and drawn at `size` pixels, as a
/// JPEG (or PNG when it has transparency to keep). A 12 MB phone photo
/// becomes a few kilobytes before it leaves the browser.
async function squareImage(file: File, size: number): Promise<Blob> {
  const url = URL.createObjectURL(file)
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image()
      el.onload = () => resolve(el)
      el.onerror = () => reject(new Error('That image could not be read.'))
      el.src = url
    })
    const side = Math.min(img.naturalWidth, img.naturalHeight)
    const canvas = document.createElement('canvas')
    canvas.width = size; canvas.height = size
    const ctx = canvas.getContext('2d')
    if (!ctx) return file
    ctx.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, size, size)
    const type = file.type === 'image/png' || file.type === 'image/gif' ? 'image/png' : 'image/jpeg'
    return await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b || file), type, 0.88))
  } finally { URL.revokeObjectURL(url) }
}
