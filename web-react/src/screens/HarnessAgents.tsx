import { AgentMemoryHistory } from '../components/AgentMemoryHistory'
import { AgentMemoryReview } from '../components/AgentMemoryReview'
import { AgentFollowups } from '../components/AgentFollowups'
import { AgentAccessDialog } from '../components/AgentAccessDialog'
import { AgentMemoryEditor } from '../components/AgentMemoryEditor'
import { AgentTierSelect } from '../components/AgentTierSelect'
import { skillImportInput } from '../utils/skillImport'
import type { SkillDraft } from '../utils/harness'
import { AgentMemoryList, MemoryKindSelect } from '../components/AgentMemoryList'
import type { MemoryKind } from '../utils/harness'
import { AgentSkillCatalog } from '../components/AgentSkillCatalog'
import { NewHarnessAgent } from '../components/NewHarnessAgent'
import { EditAgentProfile } from '../components/EditAgentProfile'
import { AgentPersona } from '../components/AgentPersona'
import type { ClientAgent } from '../utils/agents'
import { useMembers, type Mentionable } from '../utils/mentions'
import { Avatar } from '../components/Avatar'
import { AgentAvatarPreview } from '../components/AgentAvatarPreview'
import { AgentAvatar } from '../components/AgentAvatar'
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useT } from '../utils/i18n'
import { getLocale } from '../utils/locale'
import { Icon } from '../components/Icon'
import type { AgentProfile, AgentMemory, Skill } from '../utils/harness'
import { Shell, useApi, useAct, type HarnessProps } from './HarnessShared'

// Agents as members, and the skills they work by (docs/kylon-gap-plan.md).
// An agent is still written on the Agents screen; this is where it gets a
// specialty, a tier, a memory, skills, and a say in who may call it.

interface AgentFace { avatarUrl?: string | null; instructions?: string; id: string; handle: string; name: string; emoji?: string | null; description?: string; scope?: string; mine?: boolean; createdByName?: string | null; createdAt?: string }

const TIER_HINT: Record<AgentProfile['tier'], string> = {
  lite: 'Fast and cheap, for simple work.',
  standard: 'The workspace model.',
  max: 'The strongest model, for hard work.',
}

type AgentsProps = HarnessProps & { initialAgentId?: string; onMessage?: (id: string) => void; onManageAgents?: () => void; onManageTeam?: () => void }

// Keep selections and pending responses inside their authenticated workspace.
export const HarnessAgents: React.FC<AgentsProps> = (props) => (
  <ScopedHarnessAgents key={JSON.stringify([props.httpBase, props.orgId, props.sessionToken])} {...props} />
)

const ScopedHarnessAgents: React.FC<AgentsProps> = (props) => {
  const t = useT()
  const api = useApi(props)
  const [agents, setAgents] = useState<AgentFace[] | null>(null)
  const [open, setOpen] = useState<AgentFace | null>(null)
  const [person, setPerson] = useState<Mentionable | null>(null)
  const initialSelected=useRef(false)
  useEffect(()=>{if(!initialSelected.current && agents!==null){initialSelected.current=true;if(props.initialAgentId)setOpen(agents.find(a=>a.id===props.initialAgentId)||null)}},[agents,props.initialAgentId])
  const [creating, setCreating] = useState(false)
  const [filter, setFilter] = useState<'all' | 'people' | 'agents'>('all')
  const [accessRevision,setAccessRevision]=useState(0)
  const members = useMembers(props.httpBase, props.orgId, props.sessionToken)
  const { error, act } = useAct()
  useEffect(() => {
    act('load', async () => {
      const res = await fetch(`${props.httpBase}/channels/agents?orgId=${encodeURIComponent(props.orgId)}`, { headers: { 'x-session-token': props.sessionToken } })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.message || String(res.status))
      setAgents(data.agents || [])
      setOpen(current=>current ? (data.agents || []).find((a:AgentFace)=>a.id===current.id)||null : null)
    })
  }, [act, props.httpBase, props.orgId, props.sessionToken,accessRevision])

  return <div className="screen hx-members-screen">
    <aside className="hx-members-list">
      <header className="hx-chat-top"><h1>{t('Members')}</h1><details className="hx-member-add"><summary aria-label={t('New')}><Icon name="plus" size={17} /></summary><div className="hx-rail-menu"><button onClick={props.onManageTeam}>{t('Invite people')}</button><button onClick={e => { e.currentTarget.closest('details')?.removeAttribute('open'); setCreating(true) }}>{t('New agent')}</button></div></details></header>
      <div className="hx-chat-filters" role="tablist" aria-label={t('Members')}>
        {(['all', 'people', 'agents'] as const).map(f => <button key={f} role="tab" aria-selected={filter === f} onClick={() => setFilter(f)}>{t(f === 'all' ? 'All' : f === 'people' ? 'People' : 'Agents')}</button>)}
      </div>
      {error && <p role="alert">{error}</p>}
      {filter !== 'agents' && members.map(m => <button className={`hx-member-row${person?.ref === m.ref ? ' on' : ''}`} key={m.ref} onClick={() => { setPerson(m); setOpen(null) }}><Avatar name={m.name} url={m.avatarUrl} round size={40} /><span><b>{m.name}</b><small>{m.mine ? t('You') : t('Member')}</small></span></button>)}
      {filter !== 'people' && agents?.map(a => <button className={`hx-member-row${open?.id === a.id ? ' on' : ''}`} key={a.id} onClick={() => { setOpen(a); setPerson(null) }} data-agent={a.id}><AgentAvatar agent={a} className="hx-member-avatar" /><span><b>{a.name}</b><small>{t('Agent')}{a.scope === 'personal' ? ` · ${t('Only you')}` : ''}</small></span></button>)}
      {agents === null && <p className="hx-members-note">{t('Loading…')}</p>}
    </aside>
    <main className="hx-member-detail">
      {open ? <AgentMember key={open.id} {...props} agent={open} onAccessChanged={()=>setAccessRevision(v=>v+1)} onBack={() => setOpen(null)} onMessage={() => props.onMessage?.(open.id)} onUpdated={updated => { setAgents(current => current?.map(agent => agent.id === updated.id ? { ...agent, ...updated } : agent) || null); setOpen(current => current?.id === updated.id ? { ...current, ...updated } : current) }} /> : person ? <div className="hx-person-profile"><Avatar name={person.name} url={person.avatarUrl} round size={64} /><h1>{person.name}</h1>{person.handle && <p>@{person.handle}</p>}<button className="pill-btn" onClick={props.onManageTeam}>{t('Team settings')}</button></div> : <div className="hx-member-empty"><Icon name="you" size={32} /><p>{t('Choose a member')}</p></div>}
    </main>
    {creating && <NewHarnessAgent {...props} onClose={() => setCreating(false)} onAdvanced={props.onManageAgents} onCreated={(agent, all) => { setAgents(all); setOpen(agent); setPerson(null); setFilter('all'); setCreating(false) }} />}
  </div>
}

const AgentMember: React.FC<HarnessProps & { agent: AgentFace; onAccessChanged:()=>void; onBack: () => void; onMessage?: () => void; onUpdated: (agent: Partial<ClientAgent> & { id: string }) => void }> = (props) => {
  const t = useT()
  const api = useApi(props)
  const { agent } = props
  const [section, setSection] = useState<'profile' | 'skills' | 'memory' | 'followups'>('profile')
  const [editingProfile, setEditingProfile] = useState(false)
  const [accessDialog,setAccessDialog]=useState(false)
  const loadAccess=useCallback(()=>api.agentMembers(agent.id),[api,agent.id])
  const [profileDialog, setProfileDialog] = useState(false)
  const [avatarPreview, setAvatarPreview] = useState(false)
  const [profile, setProfile] = useState<AgentProfile | null>(null)
  const [canEdit, setCanEdit] = useState(false)
  const [memories, setMemories] = useState<AgentMemory[]>([])
  const [memoryCursor, setMemoryCursor] = useState<string | null>(null)
  const [memorySearch, setMemorySearch] = useState({ query: '', kind: 'all' })
  const [historyMemory, setHistoryMemory] = useState<AgentMemory | null>(null)
  const [reviewingMemory, setReviewingMemory] = useState<AgentMemory | null>(null)
  const [memoryDraft, setMemoryDraft] = useState<AgentMemory | 'new' | null>(null)
  const [skills, setSkills] = useState<Skill[]>([])
  const [allSkills, setAllSkills] = useState<Skill[]>([])
  const memoryLoad = useRef(0)
  const [memoryChannel, setMemoryChannel] = useState('')
  const [memoryScopes, setMemoryScopes] = useState<Array<{ channel: string; label: string }>>([])
  const [remember, setRemember] = useState('')
  const [memoryKind, setMemoryKind] = useState<MemoryKind>('context')
  const [people, setPeople] = useState('')
  const [saved, setSaved] = useState(false)
  const { busy, error, act } = useAct()

  const load = useCallback(() => act('load', async () => {
    const version = ++memoryLoad.current
    const [p, m, s, all, scopes] = await Promise.all([api.profile(agent.id), api.memoryPage(agent.id, memoryChannel, undefined, memorySearch), api.agentSkills(agent.id), api.skills(), api.memoryScopes(agent.id)])
    if (version !== memoryLoad.current) return
    setMemoryScopes(scopes.scopes)
    setProfile(p.profile); setCanEdit(p.canEdit); setPeople(p.profile.people.map((x) => `@${x}`).join(' '))
    setMemories(m.memories); setMemoryCursor(m.nextCursor); setSkills(s.skills); setAllSkills(all.skills)
  }), [api, act, agent.id, memoryChannel, memorySearch])
  useEffect(() => { load(); return () => { ++memoryLoad.current } }, [load])

  const save = (patch: Partial<AgentProfile>) => act('save', async () => {
    const r = await api.saveProfile(agent.id, patch)
    setProfile(r.profile); setSaved(true); setTimeout(() => setSaved(false), 1500)
  })

  if (!profile) return <Shell title={agent.name} onClose={props.onBack} nested>{error ? <div className="form-error">{error}</div> : <div className="empty">{t('Loading…')}</div>}</Shell>
  return (
    <Shell title={`${agent.emoji || '🤖'} ${agent.name}`} onClose={props.onBack} nested actions={saved ? <span className="row-sub">{t('Saved.')}</span> : null}>
      {error && <div className="form-error">{error}</div>}
      <div className="hx-profile-heading"><button className="hx-profile-avatar-trigger" aria-label={t("Show {name}’s avatar", { name: agent.name })} aria-haspopup="dialog" onClick={() => setAvatarPreview(true)}><AgentAvatar agent={agent} className="hx-profile-avatar" /></button><h1>{agent.name}</h1><button className="pill-btn quiet" onClick={props.onMessage} aria-label={t('Message')}><Icon name="message" size={18} /></button></div>
      <div className="hx-profile-tabs" role="tablist">{(['profile','skills','memory','followups'] as const).map(key => <button key={key} role="tab" aria-selected={section === key} onClick={() => setSection(key)}>{t(key === 'profile' ? 'Profile' : key === 'skills' ? 'Skills' : key === 'memory' ? 'Memory' : 'Follow-ups')}</button>)}</div>
      {accessDialog && <AgentAccessDialog load={loadAccess} transfer={(ref,version)=>api.transferAgentOwnership(agent.id,ref,version)} save={(ref,role,version)=>api.setAgentMember(agent.id,ref,role,version)} onClose={scope=>{setAccessDialog(false);props.onAccessChanged();if(scope)props.onUpdated({id:agent.id,scope});void load()}}/>}
      {avatarPreview && <AgentAvatarPreview agent={agent} onClose={() => setAvatarPreview(false)}/>}
      {profileDialog && <EditAgentProfile agent={agent} profile={profile} onClose={() => setProfileDialog(false)} onSave={async (patch, picture) => {
        const result = await api.saveProfile(agent.id, patch)
        setProfile(result.profile)
        if (result.identity) props.onUpdated({ id: agent.id, ...result.identity })
        if (picture !== undefined) {
          try {
            const response = await fetch(`${props.httpBase}/channels/agents/avatar?orgId=${encodeURIComponent(props.orgId)}&id=${encodeURIComponent(agent.id)}`, {
              method: picture ? 'POST' : 'DELETE', headers: { 'x-session-token': props.sessionToken, ...(picture ? { 'content-type': picture.type } : {}) }, ...(picture ? { body: picture } : {}),
            })
            const data = await response.json().catch(() => ({}))
            if (!response.ok || !data.agent?.id) throw new Error(data.message || t('That did not save.'))
            props.onUpdated({ id: agent.id, avatarUrl: data.agent.avatarUrl || null })
          } catch (cause) {
            throw new Error(t('Saved, but the picture did not upload: {why}', { why: cause instanceof Error ? cause.message : String(cause) }))
          }
        }
        try { window.dispatchEvent(new Event('honmaru:agents-changed')) } catch { /* no listeners */ }
      }}/>}
      {section === 'profile' && <>
      <section className="hx-profile-card"><header><span>{t('Profile')}</span>{canEdit && <button onClick={() => setProfileDialog(true)} aria-label={t('Edit profile')}><Icon name="edit" size={16} /></button>}</header>
      <dl>
        <dt><Icon name="briefcase" size={14}/>{t('Specialty')}</dt><dd>{profile.specialty || t('Not set')}</dd>
        <dt><Icon name="brain" size={14}/>{t('Intelligence')}</dt><dd>{canEdit
          ? <AgentTierSelect compact value={profile.tier} disabled={busy === 'save'} onChange={tier => void save({ tier })}/>
          : (profile.tier === 'lite' ? 'Fast' : profile.tier === 'max' ? 'Max' : 'Pro')}</dd>
        <dt><Icon name="you" size={14}/>{t('Created by')}</dt><dd>{agent.createdByName || '—'}</dd>
        <dt><Icon name="calendar" size={14}/>{t('Created at')}</dt><dd>{agent.createdAt && Number.isFinite(Date.parse(agent.createdAt)) ? new Date(agent.createdAt).toLocaleDateString(getLocale(), { year: 'numeric', month: 'long', day: 'numeric' }) : '—'}</dd>
        <dt><Icon name="lock" size={14}/>{t('Who may call it')}</dt><dd>{t(agent.scope === 'personal' ? 'Only its owner' : profile.access === 'private' ? 'Owner and assigned members' : profile.access === 'people' ? 'Some people' : 'Everyone')}</dd>
      </dl>
      <button className="btn-text" onClick={()=>setAccessDialog(true)}>{t('Agent access')}</button>
      {canEdit && <button className="btn-text" onClick={() => setEditingProfile(v => !v)}>{t('Advanced settings')}</button>}
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
              <button key={tier} className={profile.tier === tier ? 'on' : ''} disabled={!canEdit || busy === 'save'} onClick={() => save({ tier })}>{tier === 'lite' ? 'Fast' : tier === 'max' ? 'Max' : 'Pro'}</button>
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
                <button key={a} className={(agent.scope === 'personal' ? 'private' : profile.access) === a ? 'on' : ''} disabled={!canEdit || agent.scope === 'personal'} onClick={() => save({ access: a })}>{t(a === 'everyone' ? 'Everyone' : a === 'people' ? 'Some people' : agent.scope==='personal' ? 'Only its owner' : 'Owner and assigned members')}</button>
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
      </>}
      <div hidden={section !== 'profile'}><AgentPersona agent={agent} httpBase={props.httpBase} orgId={props.orgId} sessionToken={props.sessionToken} canEdit={canEdit} onUpdated={props.onUpdated} onDiscuss={props.onMessage}/></div>
      {section === 'skills' && <>
      <AgentSkillCatalog key={`${props.orgId}:${agent.id}`} skills={allSkills} installed={skills} canEdit={canEdit} onPreviewImport={async markdown => (await api.previewSkillImport(markdown)).draft} onSaveImport={async draft => {
        const version = memoryLoad.current
        const result = await api.createSkill({ ...draft, visibility: 'private' })
        if (version === memoryLoad.current) setAllSkills(current => [...current.filter(s => s.id !== result.skill.id), result.skill])
      }} onToggle={async (id, install) => {
        const version = memoryLoad.current
        if (install) await api.giveSkill(agent.id, id); else await api.takeSkill(agent.id, id)
        const result = await api.agentSkills(agent.id)
        if (version === memoryLoad.current) setSkills(result.skills)
      }} />
      <p className="row-sub">{t('Private skills run only in their owner’s direct agent conversation, including follow-ups. They are excluded from shared rooms and workflows.')}</p>

      </>}
      {section === 'memory' && <>
      <div className="rows-title">{t('Memory')}</div>
      <select aria-label={t('Memory conversation')} value={memoryChannel} disabled={busy !== null} onChange={e => { memoryLoad.current++; setMemoryDraft(null); setMemories([]); setMemoryCursor(null); setMemorySearch({ query: '', kind: 'all' }); setMemoryChannel(e.target.value) }}>
        <option value="">{t('Agent memory')}</option>
        {memoryScopes.map(scope => <option key={scope.channel} value={scope.channel}>{scope.label}</option>)}
      </select>
      <div className="rows">
        <div className="row static">
          <span className="row-main">
            <span className="row-sub">{t('Memory for this agent. Memories added in chat stay in that conversation: “@{handle} remember that …”.', { handle: agent.handle })}</span>
            <span className="playbook-add-foot hx-memory-compose">
              <MemoryKindSelect value={memoryKind} onChange={setMemoryKind} disabled={busy !== null} />
              <input className="hx-cell-input" value={remember} onChange={(e) => setRemember(e.target.value)} placeholder={t('e.g. Acme pays on the 25th')} aria-label={t('Remember')} />
              <button className="pill-btn" disabled={busy !== null || !remember.trim()} onClick={() => act('remember', async () => { await api.remember(agent.id, remember, memoryChannel, memoryKind); setRemember(''); const page = await api.memoryPage(agent.id, memoryChannel, undefined, memorySearch); setMemories(page.memories); setMemoryCursor(page.nextCursor) })}>{t('Remember')}</button>
            </span>
          </span>
        </div>
        <button className="btn-text" disabled={busy !== null} onClick={() => setMemoryDraft('new')}>{t('Add detailed memory')}</button>
        {memoryDraft && <AgentMemoryEditor memory={memoryDraft === 'new' ? undefined : memoryDraft} onClose={() => { setMemoryDraft(null); load() }} onSave={async entry => {
          const version = memoryLoad.current
          const result = memoryDraft === 'new' ? await api.rememberEntry(agent.id, entry, memoryChannel)
            : await api.updateMemory(agent.id, memoryDraft, entry, memoryDraft.channel ? memoryChannel : '')
          if (version === memoryLoad.current) setMemories(current => [result.memory, ...current.filter(item => item.id !== result.memory.id)])
        }}/>}
        {historyMemory && <AgentMemoryHistory key={historyMemory.id} memory={historyMemory} onClose={() => setHistoryMemory(null)} load={cursor => api.memoryReviews(agent.id, historyMemory.id, historyMemory.channel ? memoryChannel : '', cursor)}/>}
        {reviewingMemory && <AgentMemoryReview memory={reviewingMemory} onClose={() => { setReviewingMemory(null); void load() }} onSave={(evidence, entry) => api.reviewMemory(agent.id, reviewingMemory, evidence, reviewingMemory.channel ? memoryChannel : '', entry).then(() => {})}/>}
        <AgentMemoryList key={`${props.orgId}:${agent.id}:${memoryChannel}`} memories={memories} loading={busy === 'load' || busy === 'memory-page'} onSearch={(query, kind) => { memoryLoad.current++; setMemories([]); setMemoryCursor(null); setMemorySearch({ query, kind }) }} canEdit={canEdit} busy={busy !== null} onEdit={setMemoryDraft} onReview={setReviewingMemory} onHistory={setHistoryMemory} onForget={m => act(`forget:${m.id}`, async () => { await api.forget(agent.id, m.id, m.channel ? memoryChannel : ''); setMemories(x => x.filter(y => y.id !== m.id)) })} />
        {memoryCursor && <button className="btn-text" disabled={busy !== null} onClick={() => act('memory-page', async () => {
          const version = memoryLoad.current
          const page = await api.memoryPage(agent.id, memoryChannel, memoryCursor, memorySearch)
          if (version !== memoryLoad.current) return
          setMemories(current => [...new Map([...current, ...page.memories].map(item => [item.id, item])).values()])
          setMemoryCursor(page.nextCursor)
        })}>{t('Load more')}</button>}
      </div>

      </>}
      {section === 'followups' && <AgentFollowups key={agent.id} api={api} agentId={agent.id} />}
    </Shell>
  )
}

export const HarnessSkills: React.FC<HarnessProps> = (props) => (
  <ScopedHarnessSkills key={JSON.stringify([props.httpBase, props.orgId, props.sessionToken])} {...props} />
)

const ScopedHarnessSkills: React.FC<HarnessProps> = (props) => {
  const t = useT()
  const api = useApi(props)
  const [skills, setSkills] = useState<Skill[] | null>(null)
  const [draft, setDraft] = useState<(SkillDraft & { id?: string }) | null>(null)
  const importFile = useRef<HTMLInputElement>(null), importFolder = useRef<HTMLInputElement>(null)
  const importEpoch = useRef(0)
  const { busy, error, act } = useAct()
  const load = useCallback(() => act('load', async () => setSkills((await api.skills()).skills)), [api, act])
  useEffect(() => { load() }, [load])
  useEffect(() => { importEpoch.current++; setDraft(null); return () => { importEpoch.current++ } }, [api])
  const previewImport = (files: File[], folder = false) => {
    const epoch = ++importEpoch.current
    void act('import', async () => {
      setDraft(null)
      const result = await api.previewSkillImport(await skillImportInput(files, folder, t))
      if (epoch === importEpoch.current) setDraft(result.draft)
    })
  }
  const exportSkill = (skill: Skill, packageZip = false) => void act(`export:${skill.id}`, async () => {
    const epoch = importEpoch.current
    const result = packageZip ? await api.exportSkillPackage(skill.id) : await api.exportSkill(skill.id)
    if (epoch !== importEpoch.current) return
    const url = URL.createObjectURL(result instanceof Blob ? result : new Blob([result.markdown], { type: 'text/markdown;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = url; link.download = packageZip ? 'skill.zip' : 'SKILL.md'; document.body.appendChild(link); link.click(); link.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  })
  return (
    <Shell className="hx-skills" title={t('Skills')} onClose={props.onClose} actions={!draft && <><button className="pill-btn quiet" aria-label="スキルを取り込む" disabled={busy !== null} onClick={() => importFile.current?.click()}><Icon name="file" size={14} /> 取り込む</button><button className="pill-btn quiet" disabled={busy !== null} onClick={() => importFolder.current?.click()}>{t('Choose folder')}</button><button className="pill-btn" disabled={busy !== null} onClick={() => setDraft({ name: '', description: '', body: '' })}><Icon name="plus" size={14} /> {t('New')}</button></>}>
      <input ref={importFile} type="file" accept=".md,.zip,text/markdown,application/zip" aria-label="スキルを取り込む" hidden onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; if (file) previewImport([file]) }} />
      <input ref={importFolder} type="file" multiple {...{ webkitdirectory: '' }} hidden aria-label={t('Skill folder')} onChange={e=>{const files=Array.from(e.target.files || []);e.target.value='';if(files.length)previewImport(files,true)}}/>
      <p className="lede">{t('How your team does a thing, written once in Markdown. Give it to any agent and it follows it.')}</p>
      {busy === 'import' && <p role="status">スキルを読み込んでいます…</p>}
      {error && <div className="form-error">{t(error)}</div>}
      {draft && (
        <div className="hx-builder">
          {!draft.id && <p className="row-sub">{t('New skills are private. Share them with the workspace after saving.')}</p>}
          <input className="hx-cell-input hx-title-input" placeholder={t('Skill name')} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} aria-label={t('Skill name')} />
          <input className="hx-cell-input" placeholder={t('One line on when to use it')} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} aria-label={t('Description')} />
          <textarea className="context-input" rows={8} placeholder={t('e.g. Day 7: a polite nudge. Day 14: a call. Day 30: escalate to the owner.')} value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} aria-label={t('Skill')} />
          {!!draft.files?.length && <ul aria-label={t('Support files')}>{draft.files.map(file=><li key={file.path}>{file.path} · {file.size ?? 0} B</li>)}</ul>}
          {!!Object.keys(draft.metadata || {}).length && <details className="hx-skill-metadata"><summary>保存するメタデータ</summary><pre>{JSON.stringify(draft.metadata, null, 2)}</pre><p className="row-sub">メタデータは手順と一緒に保存されます。接続やデータのアクセス権は変更しません。</p></details>}
          <div className="playbook-add-foot">
            <button className="btn-text" onClick={() => { importEpoch.current++; setDraft(null) }}>{t('Cancel')}</button>
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
            <button className="btn-text" disabled={busy !== null} onClick={() => exportSkill(s)}><Icon name="download" size={14} /> SKILL.md</button>
            <button className="btn-text" disabled={busy !== null} onClick={() => exportSkill(s, true)}><Icon name="download" size={14}/> ZIP</button>
            <button className="btn-text" disabled={s.canEdit === false || busy !== null} onClick={() => setDraft({ id: s.id, name: s.name, description: s.description, body: s.body, metadata: s.metadata })}>{t('Edit')}</button>
            <button className="btn-text danger" disabled={s.canEdit === false} onClick={() => act(`del:${s.id}`, async () => { await api.deleteSkill(s.id); await load() })}>{t('Delete')}</button>
          </div>
        ))}
      </div>
    </Shell>
  )
}
