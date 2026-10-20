import { AgentSkillCatalog } from '../components/AgentSkillCatalog'
import { Markdown } from '../utils/markdown'
import { useMembers, type Mentionable } from '../utils/mentions'
import { Avatar } from '../components/Avatar'
import { AgentAvatar } from '../components/AgentAvatar'
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useT } from '../utils/i18n'
import { Icon } from '../components/Icon'
import type { AgentProfile, AgentMemory, Skill, Followup } from '../utils/harness'
import { Shell, useApi, useAct, type HarnessProps } from './HarnessShared'

// Agents as members, and the skills they work by (docs/kylon-gap-plan.md).
// An agent is still written on the Agents screen; this is where it gets a
// specialty, a tier, a memory, skills, and a say in who may call it.

interface AgentFace { avatarUrl?: string | null; instructions?: string; id: string; handle: string; name: string; emoji?: string | null; description?: string; scope?: string; mine?: boolean }

const TIER_HINT: Record<AgentProfile['tier'], string> = {
  lite: 'Fast and cheap, for simple work.',
  standard: 'The workspace model.',
  max: 'The strongest model, for hard work.',
}

export const HarnessAgents: React.FC<HarnessProps & { onMessage?: (id: string) => void; onManageAgents?: () => void; onManageTeam?: () => void }> = (props) => {
  const t = useT()
  const api = useApi(props)
  const [agents, setAgents] = useState<AgentFace[] | null>(null)
  const [open, setOpen] = useState<AgentFace | null>(null)
  const [person, setPerson] = useState<Mentionable | null>(null)
  const [filter, setFilter] = useState<'all' | 'people' | 'agents'>('all')
  const members = useMembers(props.httpBase, props.orgId, props.sessionToken)
  const { error, act } = useAct()
  useEffect(() => {
    act('load', async () => {
      const res = await fetch(`${props.httpBase}/channels/agents?orgId=${encodeURIComponent(props.orgId)}`, { headers: { 'x-session-token': props.sessionToken } })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.message || String(res.status))
      setAgents(data.agents || [])
    })
  }, [act, props.httpBase, props.orgId, props.sessionToken])

  return <div className="screen hx-members-screen">
    <aside className="hx-members-list">
      <header className="hx-chat-top"><h1>{t('Members')}</h1><details className="hx-member-add"><summary aria-label={t('New')}><Icon name="plus" size={17} /></summary><div className="hx-rail-menu"><button onClick={props.onManageTeam}>{t('Invite people')}</button><button onClick={props.onManageAgents}>{t('New agent')}</button></div></details></header>
      <div className="hx-chat-filters" role="tablist" aria-label={t('Members')}>
        {(['all', 'people', 'agents'] as const).map(f => <button key={f} role="tab" aria-selected={filter === f} onClick={() => setFilter(f)}>{t(f === 'all' ? 'All' : f === 'people' ? 'People' : 'Agents')}</button>)}
      </div>
      {error && <p role="alert">{error}</p>}
      {filter !== 'agents' && members.map(m => <button className={`hx-member-row${person?.ref === m.ref ? ' on' : ''}`} key={m.ref} onClick={() => { setPerson(m); setOpen(null) }}><Avatar name={m.name} url={m.avatarUrl} round size={40} /><span><b>{m.name}</b><small>{m.mine ? t('You') : t('Member')}</small></span></button>)}
      {filter !== 'people' && agents?.map(a => <button className={`hx-member-row${open?.id === a.id ? ' on' : ''}`} key={a.id} onClick={() => { setOpen(a); setPerson(null) }} data-agent={a.id}><AgentAvatar agent={a} className="hx-member-avatar" /><span><b>{a.name}</b><small>{t('Agent')}{a.scope === 'personal' ? ` · ${t('Only you')}` : ''}</small></span></button>)}
      {agents === null && <p className="hx-members-note">{t('Loading…')}</p>}
    </aside>
    <main className="hx-member-detail">
      {open ? <AgentMember key={open.id} {...props} agent={open} onBack={() => setOpen(null)} onMessage={() => props.onMessage?.(open.id)} onEdit={props.onManageAgents} /> : person ? <div className="hx-person-profile"><Avatar name={person.name} url={person.avatarUrl} round size={64} /><h1>{person.name}</h1>{person.handle && <p>@{person.handle}</p>}<button className="pill-btn" onClick={props.onManageTeam}>{t('Team settings')}</button></div> : <div className="hx-member-empty"><Icon name="you" size={32} /><p>{t('Choose a member')}</p></div>}
    </main>
  </div>
}

const AgentMember: React.FC<HarnessProps & { agent: AgentFace; onBack: () => void; onMessage?: () => void; onEdit?: () => void }> = (props) => {
  const t = useT()
  const api = useApi(props)
  const { agent } = props
  const [section, setSection] = useState<'profile' | 'skills' | 'memory' | 'followups'>('profile')
  const [editingProfile, setEditingProfile] = useState(false)
  const [profile, setProfile] = useState<AgentProfile | null>(null)
  const [canEdit, setCanEdit] = useState(false)
  const [memories, setMemories] = useState<AgentMemory[]>([])
  const [skills, setSkills] = useState<Skill[]>([])
  const [allSkills, setAllSkills] = useState<Skill[]>([])
  const [followups, setFollowups] = useState<Followup[]>([])
  const memoryLoad = useRef(0)
  const [memoryChannel, setMemoryChannel] = useState('')
  const [memoryScopes, setMemoryScopes] = useState<Array<{ channel: string; label: string }>>([])
  const [remember, setRemember] = useState('')
  const [people, setPeople] = useState('')
  const [saved, setSaved] = useState(false)
  const { busy, error, act } = useAct()

  const load = useCallback(() => act('load', async () => {
    const version = ++memoryLoad.current
    const [p, m, s, all, f, scopes] = await Promise.all([api.profile(agent.id), api.memory(agent.id, memoryChannel), api.agentSkills(agent.id), api.skills(), api.followups(), api.memoryScopes(agent.id)])
    if (version !== memoryLoad.current) return
    setMemoryScopes(scopes.scopes)
    setProfile(p.profile); setCanEdit(p.canEdit); setPeople(p.profile.people.map((x) => `@${x}`).join(' '))
    setMemories(m.memories); setSkills(s.skills); setAllSkills(all.skills)
    setFollowups(f.followups.filter((x) => x.agentId === agent.id))
  }), [api, act, agent.id, memoryChannel])
  useEffect(() => { load() }, [load])

  const save = (patch: Partial<AgentProfile>) => act('save', async () => {
    const r = await api.saveProfile(agent.id, patch)
    setProfile(r.profile); setSaved(true); setTimeout(() => setSaved(false), 1500)
  })

  if (!profile) return <Shell title={agent.name} onClose={props.onBack} nested>{error ? <div className="form-error">{error}</div> : <div className="empty">{t('Loading…')}</div>}</Shell>
  return (
    <Shell title={`${agent.emoji || '🤖'} ${agent.name}`} onClose={props.onBack} nested actions={saved ? <span className="row-sub">{t('Saved.')}</span> : null}>
      {error && <div className="form-error">{error}</div>}
      <div className="hx-profile-heading"><AgentAvatar agent={agent} className="hx-profile-avatar" /><h1>{agent.name}</h1><button className="pill-btn quiet" onClick={props.onMessage} aria-label={t('Message')}><Icon name="message" size={18} /></button></div>
      <div className="hx-profile-tabs" role="tablist">{(['profile','skills','memory','followups'] as const).map(key => <button key={key} role="tab" aria-selected={section === key} onClick={() => setSection(key)}>{t(key === 'profile' ? 'Profile' : key === 'skills' ? 'Skills' : key === 'memory' ? 'Memory' : 'Follow-ups')}</button>)}</div>
      {section === 'profile' && <>
      <section className="hx-profile-card"><header><span>{t('Profile')}</span>{canEdit && <button onClick={() => setEditingProfile(v => !v)} aria-label={t(editingProfile ? 'Close' : 'Edit profile')}><Icon name={editingProfile ? 'x' : 'edit'} size={16} /></button>}</header>
      {!editingProfile && <dl><dt>{t('Specialty')}</dt><dd>{profile.specialty || '—'}</dd><dt>{t('Intelligence')}</dt><dd>{t(profile.tier === 'lite' ? 'Lite' : profile.tier === 'max' ? 'Max' : 'Standard')}</dd><dt>{t('Who may call it')}</dt><dd>{t(agent.scope === 'personal' || profile.access === 'private' ? 'Only its maker' : profile.access === 'people' ? 'Some people' : 'Everyone')}</dd></dl>}
      {editingProfile && <>
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
                <button key={a} className={(agent.scope === 'personal' ? 'private' : profile.access) === a ? 'on' : ''} disabled={!canEdit || agent.scope === 'personal'} onClick={() => save({ access: a })}>{t(a === 'everyone' ? 'Everyone' : a === 'people' ? 'Some people' : 'Only its maker')}</button>
              ))}
            </span>
            {agent.scope === 'personal' && <span className="row-sub">{t('This agent is personal. Its owner can share it from the Agents screen.')}</span>}
            {agent.scope !== 'personal' && profile.access === 'people' && (
              <span className="playbook-add-foot">
                <input className="hx-cell-input" disabled={!canEdit} value={people} onChange={(e) => setPeople(e.target.value)} placeholder="@mika @kenji" aria-label={t('People')} />
                <button className="pill-btn" disabled={!canEdit} onClick={() => save({ people: people.split(/[\s,]+/).map((x) => x.replace(/^@/, '')).filter(Boolean) })}>{t('Save')}</button>
              </span>
            )}
          </span>
        </div>
      </div>

      </>}
      {saved && <p role="status">{t('Saved.')}</p>}
      </section>
      <section className="hx-persona"><header><span>{t('Persona')}</span>{canEdit && <button onClick={props.onEdit} aria-label={t('Edit')}><Icon name="edit" size={16} /></button>}</header><p>{agent.description}</p><div className="hx-persona-text"><Markdown source={agent.instructions || t('Edit this agent to set its instructions.')} /></div></section>
      </>}
      {section === 'skills' && <>
      <div className="rows-title">{t('Skills')}</div>
      <p className="row-sub">{t('Private skills run only in their owner’s direct agent conversation, including follow-ups. They are excluded from shared rooms and workflows.')}</p>
      <AgentSkillCatalog key={`${props.orgId}:${agent.id}`} skills={allSkills} installed={skills} canEdit={canEdit} onToggle={async (id, install) => {
        const version = memoryLoad.current
        if (install) await api.giveSkill(agent.id, id); else await api.takeSkill(agent.id, id)
        const result = await api.agentSkills(agent.id)
        if (version === memoryLoad.current) setSkills(result.skills)
      }} />

      </>}
      {section === 'memory' && <>
      <div className="rows-title">{t('Memory')}</div>
      <select aria-label={t('Memory conversation')} value={memoryChannel} disabled={busy !== null} onChange={e => { memoryLoad.current++; setMemories([]); setMemoryChannel(e.target.value) }}>
        <option value="">{t('Shared knowledge')}</option>
        {memoryScopes.map(scope => <option key={scope.channel} value={scope.channel}>{scope.label}</option>)}
      </select>
      <div className="rows">
        <div className="row static">
          <span className="row-main">
            <span className="row-sub">{t('Shared knowledge for this agent. Memories added in chat stay in that conversation: “@{handle} remember that …”.', { handle: agent.handle })}</span>
            <span className="playbook-add-foot">
              <input className="hx-cell-input" value={remember} onChange={(e) => setRemember(e.target.value)} placeholder={t('e.g. Acme pays on the 25th')} aria-label={t('Remember')} />
              <button className="pill-btn" disabled={!remember.trim()} onClick={() => act('remember', async () => { await api.remember(agent.id, remember, memoryChannel); setRemember(''); setMemories((await api.memory(agent.id, memoryChannel)).memories) })}>{t('Remember')}</button>
            </span>
          </span>
        </div>
        {memories.map((m) => (
          <div key={m.id} className="row static memory-row">
            <span className="row-main"><span className="memory-text">{m.text}</span><span className="row-sub">{new Date(m.createdAt).toLocaleDateString()}</span></span>
            {canEdit && <button className="btn-text" onClick={() => act(`forget:${m.id}`, async () => { await api.forget(agent.id, m.id, m.channel ? memoryChannel : ''); setMemories((x) => x.filter((y) => y.id !== m.id)) })}>{t('Forget')}</button>}
          </div>
        ))}
      </div>

      </>}
      {section === 'followups' && <>
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
      </>}
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
          {!draft.id && <p className="row-sub">{t('New skills are private. Share them with the workspace after saving.')}</p>}
          <input className="hx-cell-input hx-title-input" placeholder={t('Skill name')} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} aria-label={t('Skill name')} />
          <input className="hx-cell-input" placeholder={t('One line on when to use it')} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} aria-label={t('Description')} />
          <textarea className="context-input" rows={8} placeholder={t('e.g. Day 7: a polite nudge. Day 14: a call. Day 30: escalate to the owner.')} value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} aria-label={t('Skill')} />
          <div className="playbook-add-foot">
            <button className="btn-text" onClick={() => setDraft(null)}>{t('Cancel')}</button>
            <button className="pill-btn" disabled={busy === 'save' || !draft.name.trim() || !draft.body.trim()} onClick={() => act('save', async () => {
              if (draft.id) await api.updateSkill(draft.id, draft); else await api.createSkill({ ...draft, visibility: 'private' })
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
            <select aria-label={t('Skill visibility')} value={s.visibility || 'workspace'} disabled={!s.canShare || busy !== null} onChange={e => {
              const visibility = e.target.value as 'private' | 'workspace';
              act(`share:${s.id}`, async () => { await api.setSkillAccess(s.id, visibility, s.accessVersion || 0); await load() })
            }}>
              <option value="private">{t('Only me')}</option><option value="workspace">{t('Everyone on the team')}</option>
            </select>
            <span className="row-main">{s.name}<span className="row-sub">{s.description || s.body.slice(0, 100)}{s.agents?.length ? ` · ${t('{n} agents', { n: s.agents.length })}` : ''}</span></span>
            <button className="btn-text" disabled={s.canEdit === false} onClick={() => setDraft({ id: s.id, name: s.name, description: s.description, body: s.body })}>{t('Edit')}</button>
            <button className="btn-text danger" disabled={s.canEdit === false} onClick={() => act(`del:${s.id}`, async () => { await api.deleteSkill(s.id); await load() })}>{t('Delete')}</button>
          </div>
        ))}
      </div>
    </Shell>
  )
}
