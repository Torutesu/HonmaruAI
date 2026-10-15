import React, { useCallback, useEffect, useState } from 'react'
import { useT } from '../utils/i18n'
import { Icon } from '../components/Icon'
import type { AgentProfile, AgentMemory, Skill, Followup } from '../utils/harness'
import { Shell, useApi, useAct, type HarnessProps } from './HarnessShared'

// Agents as members, and the skills they work by (docs/kylon-gap-plan.md).
// An agent is still written on the Agents screen; this is where it gets a
// specialty, a tier, a memory, skills, and a say in who may call it.

interface AgentFace { id: string; handle: string; name: string; emoji?: string | null; description?: string; scope?: string; mine?: boolean }

const TIER_HINT: Record<AgentProfile['tier'], string> = {
  lite: 'Fast and cheap, for simple work.',
  standard: 'The workspace model.',
  max: 'The strongest model, for hard work.',
}

export const HarnessAgents: React.FC<HarnessProps> = (props) => {
  const t = useT()
  const api = useApi(props)
  const [agents, setAgents] = useState<AgentFace[] | null>(null)
  const [open, setOpen] = useState<AgentFace | null>(null)
  const { error, act } = useAct()
  useEffect(() => {
    act('load', async () => {
      const res = await fetch(`${props.httpBase}/channels/agents?orgId=${encodeURIComponent(props.orgId)}`, { headers: { 'x-session-token': props.sessionToken } })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.message || String(res.status))
      setAgents(data.agents || [])
    })
  }, [act, props.httpBase, props.orgId, props.sessionToken])

  if (open) return <AgentMember {...props} agent={open} onBack={() => setOpen(null)} />
  return (
    <Shell title={t('Agent team')} onClose={props.onClose}>
      <p className="lede">{t('Agents are members of the team: each with a specialty, a memory of its own, skills, and the people who may call it.')}</p>
      {error && <div className="form-error">{error}</div>}
      {agents === null && <div className="empty">{t('Loading…')}</div>}
      {agents?.length === 0 && <div className="empty">{t('No agents yet. Write one on the Agents screen, then give it a role here.')}</div>}
      <div className="rows">
        {agents?.map((a) => (
          <button key={a.id} className="row" onClick={() => { void api; setOpen(a) }} data-agent={a.id}>
            <span className="row-icon hx-emoji">{a.emoji || '🤖'}</span>
            <span className="row-main">{a.name} <span className="row-sub">@{a.handle}{a.description ? ` · ${a.description}` : ''}</span></span>
            <span className="row-value">›</span>
          </button>
        ))}
      </div>
    </Shell>
  )
}

const AgentMember: React.FC<HarnessProps & { agent: AgentFace; onBack: () => void }> = (props) => {
  const t = useT()
  const api = useApi(props)
  const { agent } = props
  const [profile, setProfile] = useState<AgentProfile | null>(null)
  const [canEdit, setCanEdit] = useState(false)
  const [memories, setMemories] = useState<AgentMemory[]>([])
  const [skills, setSkills] = useState<Skill[]>([])
  const [allSkills, setAllSkills] = useState<Skill[]>([])
  const [followups, setFollowups] = useState<Followup[]>([])
  const [remember, setRemember] = useState('')
  const [people, setPeople] = useState('')
  const [saved, setSaved] = useState(false)
  const { busy, error, act } = useAct()

  const load = useCallback(() => act('load', async () => {
    const [p, m, s, all, f] = await Promise.all([api.profile(agent.id), api.memory(agent.id), api.agentSkills(agent.id), api.skills(), api.followups()])
    setProfile(p.profile); setCanEdit(p.canEdit); setPeople(p.profile.people.map((x) => `@${x}`).join(' '))
    setMemories(m.memories); setSkills(s.skills); setAllSkills(all.skills)
    setFollowups(f.followups.filter((x) => x.agentId === agent.id))
  }), [api, act, agent.id])
  useEffect(() => { load() }, [load])

  const save = (patch: Partial<AgentProfile>) => act('save', async () => {
    const r = await api.saveProfile(agent.id, patch)
    setProfile(r.profile); setSaved(true); setTimeout(() => setSaved(false), 1500)
  })

  if (!profile) return <Shell title={agent.name} onClose={props.onBack} nested>{error ? <div className="form-error">{error}</div> : <div className="empty">{t('Loading…')}</div>}</Shell>
  const has = new Set(skills.map((s) => s.id))
  return (
    <Shell title={`${agent.emoji || '🤖'} ${agent.name}`} onClose={props.onBack} nested actions={saved ? <span className="row-sub">{t('Saved.')}</span> : null}>
      {error && <div className="form-error">{error}</div>}
      <div className="rows-title">{t('Role')}</div>
      <div className="rows">
        <div className="row static">
          <span className="row-main">{t('Specialty')}
            <input className="hx-cell-input" disabled={!canEdit} defaultValue={profile.specialty} placeholder={t('e.g. Accounts receivable')} onBlur={(e) => e.target.value !== profile.specialty && save({ specialty: e.target.value })} aria-label={t('Specialty')} />
          </span>
        </div>
        <div className="row static">
          <span className="row-main">{t('Intelligence')}<span className="row-sub">{t(TIER_HINT[profile.tier])}</span></span>
          <span className="hx-seg">
            {(['lite', 'standard', 'max'] as const).map((tier) => (
              <button key={tier} className={profile.tier === tier ? 'on' : ''} disabled={!canEdit || busy === 'save'} onClick={() => save({ tier })}>{t(tier === 'lite' ? 'Lite' : tier === 'max' ? 'Max' : 'Standard')}</button>
            ))}
          </span>
        </div>
        <label className="row static">
          <span className="row-main">{t('Answer only when named')}<span className="row-sub">{t('It stays out of a thread unless someone writes its @name.')}</span></span>
          <input type="checkbox" disabled={!canEdit} checked={profile.mentionOnly} onChange={(e) => save({ mentionOnly: e.target.checked })} />
        </label>
        <div className="row static">
          <span className="row-main">{t('Who may call it')}
            <span className="hx-seg">
              {(['everyone', 'people', 'private'] as const).map((a) => (
                <button key={a} className={profile.access === a ? 'on' : ''} disabled={!canEdit} onClick={() => save({ access: a })}>{t(a === 'everyone' ? 'Everyone' : a === 'people' ? 'Some people' : 'Only its maker')}</button>
              ))}
            </span>
            {profile.access === 'people' && (
              <span className="playbook-add-foot">
                <input className="hx-cell-input" disabled={!canEdit} value={people} onChange={(e) => setPeople(e.target.value)} placeholder="@mika @kenji" aria-label={t('People')} />
                <button className="pill-btn" disabled={!canEdit} onClick={() => save({ people: people.split(/[\s,]+/).map((x) => x.replace(/^@/, '')).filter(Boolean) })}>{t('Save')}</button>
              </span>
            )}
          </span>
        </div>
      </div>

      <div className="rows-title">{t('Skills')}</div>
      <div className="rows">
        {allSkills.length === 0 && <div className="row static"><span className="row-sub">{t('No skills in this workspace yet. Write one on the Skills screen.')}</span></div>}
        {allSkills.map((s) => (
          <label key={s.id} className="row static">
            <span className="row-main">{s.name}<span className="row-sub">{s.description}</span></span>
            <input type="checkbox" disabled={!canEdit} checked={has.has(s.id)} onChange={(e) => act(`skill:${s.id}`, async () => {
              if (e.target.checked) await api.giveSkill(agent.id, s.id); else await api.takeSkill(agent.id, s.id)
              setSkills((await api.agentSkills(agent.id)).skills)
            })} />
          </label>
        ))}
      </div>

      <div className="rows-title">{t('Memory')}</div>
      <div className="rows">
        <div className="row static">
          <span className="row-main">
            <span className="row-sub">{t('What it carries from one conversation to the next. In a chat: “@{handle} remember that …”.', { handle: agent.handle })}</span>
            <span className="playbook-add-foot">
              <input className="hx-cell-input" value={remember} onChange={(e) => setRemember(e.target.value)} placeholder={t('e.g. Acme pays on the 25th')} aria-label={t('Remember')} />
              <button className="pill-btn" disabled={!remember.trim()} onClick={() => act('remember', async () => { await api.remember(agent.id, remember); setRemember(''); setMemories((await api.memory(agent.id)).memories) })}>{t('Remember')}</button>
            </span>
          </span>
        </div>
        {memories.map((m) => (
          <div key={m.id} className="row static memory-row">
            <span className="row-main"><span className="memory-text">{m.text}</span><span className="row-sub">{new Date(m.createdAt).toLocaleDateString()}</span></span>
            {canEdit && <button className="btn-text" onClick={() => act(`forget:${m.id}`, async () => { await api.forget(agent.id, m.id); setMemories((x) => x.filter((y) => y.id !== m.id)) })}>{t('Forget')}</button>}
          </div>
        ))}
      </div>

      <div className="rows-title">{t('Follow-ups')}</div>
      <div className="rows">
        {followups.length === 0 && <div className="row static"><span className="row-sub">{t('Nothing scheduled. In a chat: “@{handle} follow up in 3 days: …”.', { handle: agent.handle })}</span></div>}
        {followups.map((f) => (
          <div key={f.id} className="row static">
            <span className="row-icon"><Icon name="clock" size={18} /></span>
            <span className="row-main">{f.instruction}<span className="row-sub">{f.channel.replace(/^b:/, '#')} · {new Date(f.dueAt).toLocaleString()}</span></span>
            <button className="btn-text" onClick={() => act(`cancel:${f.id}`, async () => { await api.cancelFollowup(f.id); setFollowups((x) => x.filter((y) => y.id !== f.id)) })}>{t('Cancel')}</button>
          </div>
        ))}
      </div>
    </Shell>
  )
}

export const HarnessSkills: React.FC<HarnessProps> = (props) => {
  const t = useT()
  const api = useApi(props)
  const [skills, setSkills] = useState<Skill[] | null>(null)
  const [draft, setDraft] = useState<{ id?: string; name: string; description: string; body: string } | null>(null)
  const { busy, error, act } = useAct()
  const load = useCallback(() => act('load', async () => setSkills((await api.skills()).skills)), [api, act])
  useEffect(() => { load() }, [load])
  return (
    <Shell title={t('Skills')} onClose={props.onClose} actions={!draft && <button className="pill-btn" onClick={() => setDraft({ name: '', description: '', body: '' })}><Icon name="plus" size={14} /> {t('New')}</button>}>
      <p className="lede">{t('How your team does a thing, written once in Markdown. Give it to any agent and it follows it.')}</p>
      {error && <div className="form-error">{error}</div>}
      {draft && (
        <div className="hx-builder">
          <input className="hx-cell-input hx-title-input" placeholder={t('Skill name')} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} aria-label={t('Skill name')} />
          <input className="hx-cell-input" placeholder={t('One line on when to use it')} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} aria-label={t('Description')} />
          <textarea className="context-input" rows={8} placeholder={t('e.g. Day 7: a polite nudge. Day 14: a call. Day 30: escalate to the owner.')} value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} aria-label={t('Skill')} />
          <div className="playbook-add-foot">
            <button className="btn-text" onClick={() => setDraft(null)}>{t('Cancel')}</button>
            <button className="pill-btn" disabled={busy === 'save' || !draft.name.trim() || !draft.body.trim()} onClick={() => act('save', async () => {
              if (draft.id) await api.updateSkill(draft.id, draft); else await api.createSkill(draft)
              setDraft(null); await load()
            })}>{t('Save')}</button>
          </div>
        </div>
      )}
      {skills === null && <div className="empty">{t('Loading…')}</div>}
      {skills?.length === 0 && !draft && <div className="empty">{t('No skills yet.')}</div>}
      <div className="rows">
        {skills?.map((s) => (
          <div key={s.id} className="row static" data-skill={s.id}>
            <span className="row-icon"><Icon name="book" size={18} /></span>
            <span className="row-main">{s.name}<span className="row-sub">{s.description || s.body.slice(0, 100)}{s.agents?.length ? ` · ${t('{n} agents', { n: s.agents.length })}` : ''}</span></span>
            <button className="btn-text" onClick={() => setDraft({ id: s.id, name: s.name, description: s.description, body: s.body })}>{t('Edit')}</button>
            <button className="btn-text danger" onClick={() => act(`del:${s.id}`, async () => { await api.deleteSkill(s.id); await load() })}>{t('Delete')}</button>
          </div>
        ))}
      </div>
    </Shell>
  )
}
