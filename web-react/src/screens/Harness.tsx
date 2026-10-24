import { useFloatingApp } from '../components/FloatingAppContext'
import {AppConversationInbox} from '../components/AppConversationInbox'
import {AppConversationPanel} from '../components/AppConversationPanel'
import {AppRecordDialog} from '../components/AppRecordDialog'
import {AppDataMenu} from '../components/AppDataMenu'
import {displayLayout, isSystemColumn, systemCellText, nextColumnSort} from '../utils/systemColumns'
import { ColumnResize } from '../components/ColumnResize'
import { PersonalViewControls } from '../components/PersonalViewControls'
import type { PersonalViews } from '../utils/harness'
import { AppViewControls } from '../components/AppViewControls'
import { HarnessAppPreview } from '../components/HarnessAppPreview'
import { HarnessAppMenu } from '../components/HarnessAppMenu'
import { useAppPins } from '../utils/appPins'
import { HarnessAppIcon } from '../components/HarnessAppIcon'
import { CompanyApp } from '../components/CompanyApp'
import { CustomAppEditor, CustomAppFrame } from "../components/CustomApp"
import { AppSharing } from '../components/AppSharing'
import { AppCalendar } from '../components/AppCalendar'
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useT } from '../utils/i18n'
import { Icon } from '../components/Icon'
import { hashForApp, hashForAppSource, hashForCard, consumeAppDraftHash, appSectionHash, type AppSection } from '../utils/route'
import {
  useWorkspaceMode, cellText, metricText, WANT_MODE_KEY, SET_MODE_EVENT, isMode, type WorkspaceMode,
  type App, type Template, type Table, type Row, type View, type Column, type HarnessApi,
} from '../utils/harness'
import { Shell, useApi, useAct, type HarnessProps, type HarnessScreen } from './HarnessShared'
import { ModePicker } from './HarnessHome'

// The harness screens (docs/kylon-gap-plan.md): Apps, Workflows, Approvals,
// Skills and agents as members, and the hub that switches a workspace into
// harness mode. Nothing here is reached from a simple workspace except the
// hub's switch, so the feed and the chat stay what they were.

// ── Hub ─────────────────────────────────────────────────────────────────

export const HarnessHub: React.FC<HarnessProps & { onOpen: (s: HarnessScreen) => void }> = (props) => {
  const t = useT()
  const { mode, workspaceMode, canEdit, loaded, setMode, simpleOnly, setSimpleOnly } = useWorkspaceMode(props.httpBase, props.orgId, props.sessionToken)
  const { busy, error, setError, act } = useAct()
  // A mode asked for from the desktop app's menu: applied once the server
  // has said whether this person may, and refused out loud when not.
  const [wanted, setWanted] = useState<WorkspaceMode | null>(() => {
    try {
      const w = sessionStorage.getItem(WANT_MODE_KEY)
      sessionStorage.removeItem(WANT_MODE_KEY)
      return isMode(w) ? w : null
    } catch { return null }
  })
  useEffect(() => {
    const onAsk = (e: Event) => { const m = (e as CustomEvent).detail; if (isMode(m)) setWanted(m) }
    window.addEventListener(SET_MODE_EVENT, onAsk)
    return () => window.removeEventListener(SET_MODE_EVENT, onAsk)
  }, [])
  useEffect(() => {
    if (!wanted || !loaded) return
    setWanted(null)
    if (wanted === workspaceMode) return
    if (!canEdit) { setError(t('Only an admin can change the workspace mode.')); return }
    void act('mode', async () => { await setMode(wanted); if (wanted === 'harness' && !simpleOnly) props.onOpen('home') })
  }, [wanted, loaded, workspaceMode, simpleOnly, canEdit, setMode, act, setError, t])
  const on = mode === 'harness'
  const rows: Array<{ screen: HarnessScreen; icon: Parameters<typeof Icon>[0]['name']; title: string; sub: string }> = [
    { screen: 'apps', icon: 'grid', title: t('Apps'), sub: t('Internal tools your team and agents build: trackers, boards, dashboards.') },
    { screen: 'workflows', icon: 'zap', title: t('Workflows'), sub: t('A trigger and the steps that follow, with every run kept.') },
    { screen: 'approvals', icon: 'check', title: t('Approvals'), sub: t('What agents and workflows are waiting on you for.') },
    { screen: 'hxagents', icon: 'sparkle', title: t('Agent team'), sub: t('Specialty, tier, memory and who may call each agent.') },
    { screen: 'gateways', icon: 'zap', title: t('Execution nodes'), sub: t('Run isolated jobs on your own machines.') },
    { screen: 'skills', icon: 'book', title: t('Skills'), sub: t('How your team does a thing, written once and given to agents.') },
  ]
  return (
    <Shell title={t('Harness')} onClose={props.onClose}>
      <p className="lede">{t('One workspace where your team and AI agents run the business together. Simple mode keeps Honmaru as it is: the decision feed and the chat.')}</p>
      <div className="rows">
        <label className="row">
          <input type="checkbox" checked={simpleOnly} onChange={e => setSimpleOnly(e.target.checked)} />
          <span className="row-main">{t('Use only Simple in this browser')}<span className="row-sub">{t('Keep the decision feed and chat. Shared apps and workflows stay saved.')}</span></span>
        </label>
      </div>
      <div className="rows-title">{t('Workspace mode')}</div>
      <ModePicker mode={workspaceMode} canEdit={canEdit} busy={busy === 'mode'} onPick={(m) => void act('mode', async () => { await setMode(m); if (m === 'harness' && !simpleOnly) props.onOpen('home') })} />
      {!canEdit && <p className="hx-hint">{t('Only an admin can change the workspace mode.')}</p>}
      {error && <div className="form-error">{error}</div>}
      {on && (
        <div className="rows">
          {rows.map((r) => (
            <button key={r.screen} className="row" onClick={() => props.onOpen(r.screen)} data-open={r.screen}>
              <span className="row-icon"><Icon name={r.icon} size={18} /></span>
              <span className="row-main">{r.title}<span className="row-sub">{r.sub}</span></span>
              <span className="row-value">›</span>
            </button>
          ))}
        </div>
      )}
    </Shell>
  )
}

// ── Apps ────────────────────────────────────────────────────────────────

export const HarnessApps: React.FC<HarnessProps & { requestedAppId?: string | null; initialSection?:AppSection; initialDraft?:string; initialConversation?: {tableId?:string;rowId?:string} }> = (props) => {
  const t = useT()
  const api = useApi(props)
  const generationRequest = useRef<{key:string;id:string}|null>(null)
  const liveApi = useRef<HarnessApi | null>(api)
  liveApi.current = api
  useEffect(() => { liveApi.current = api; return () => { liveApi.current = null } }, [api])
  const { pins, toggle } = useAppPins(props.orgId,api)
  const [apps, setApps] = useState<App[] | null>(null)
  const [templates, setTemplates] = useState<Template[]>([])
  // An app opened from a room's details (RoomApps) arrives already open.
  const [open, setOpen] = useState<string | null>(() => {
    if (props.requestedAppId) return props.requestedAppId
    try { const id = sessionStorage.getItem('hx.openApp'); sessionStorage.removeItem('hx.openApp'); return id } catch { return null }
  })
  const [prompt, setPrompt] = useState('')
  const [creating, setCreating] = useState(false)
  const [query, setQuery] = useState('')
  const [note, setNote] = useState<string | null>(null)
  const { busy, error, act } = useAct()

  const load = useCallback(() => act('load', async () => {
    const [a, tpl] = await Promise.all([api.apps(), api.templates()])
    setApps(a.apps); setTemplates(tpl.templates)
  }), [api, act])
  useEffect(() => { load() }, [load])

  const previousRequestedApp = useRef(props.requestedAppId)
  useEffect(() => {
    if (previousRequestedApp.current !== props.requestedAppId) setOpen(props.requestedAppId || null)
    previousRequestedApp.current = props.requestedAppId
  }, [props.requestedAppId])
  const openApp = (id: string) => { setOpen(id); location.hash = hashForApp(id, props.orgId) }
  if (open) return <AppView key={open} {...props} api={api} appId={open} onBack={() => { setOpen(null); location.hash = '#/apps'; load() }} />

  const generate = () => act('generate', async () => {
    const startingHash = location.hash
    const submittedPrompt = prompt
    const room = prompt.match(/#([\p{L}\p{N}_-]+)/u)?.[1]
    const key = JSON.stringify([props.orgId,prompt,room])
    if (generationRequest.current?.key !== key) generationRequest.current = {key,id:crypto.randomUUID()}
    const made = await api.generate(prompt, room ? `b:${room}` : undefined, {requestId:generationRequest.current.id,captureSource:Boolean(room)})
    if (liveApi.current !== api) return
    generationRequest.current = null
    setPrompt(current => current === submittedPrompt ? '' : current)
    // Publication can finish after leaving this screen or opening another
    // app. Keep that navigation; the finished app remains in the library.
    if (location.hash !== startingHash) return
    setNote(made.source === 'model' ? t('Built from your description.') : t('Started from the closest template. Change its columns any time.'))
    if(room) location.hash = hashForAppSource(made.app.id, props.orgId)
    else { setOpen(made.app.id); location.hash = hashForApp(made.app.id, props.orgId) }
  })
  const fromTemplate = (id: string) => act(`tpl:${id}`, async () => {
    const made = await api.createFromTemplate(id)
    openApp(made.app.id)
  })

  return (
    <Shell className="hx-resource-screen hx-app-library" title={t('Apps')} onClose={props.onClose} actions={<button className="pill-btn" onClick={() => setCreating(v => !v)}>{t(creating ? 'Cancel' : 'Build an app')}</button>}>
      {creating && <>
      <div className="rows">
        <div className="row static">
          <span className="row-main">
            {t('Describe an app')}
            <textarea
              className="context-input"
              rows={2}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={t('e.g. An invoice tracker for #ops, from the billing inbox')}
              aria-label={t('Describe an app')}
            />
            <span className="playbook-add-foot">
              <span className="row-sub">{t('Your AI designs the table and its views.')}</span>
              <button className="pill-btn" onClick={generate} disabled={busy === 'generate' || !prompt.trim()}>{busy === 'generate' ? t('Building…') : t('Build')}</button>
            </span>
          </span>
        </div>
      </div>
      </>}
      {note && <div className="form-note">{note}</div>}
      {error && <div className="form-error">{error}</div>}

      <label className="hx-library-search"><Icon name="search" size={16} /><input type="search" aria-label="アプリを検索" placeholder="アプリを検索" value={query} onChange={e => setQuery(e.target.value)} /></label>
      {apps === null && <div className="empty">{t('Loading…')}</div>}
      {apps?.length === 0 && !creating && <div className="hx-resource-empty"><span className="hx-resource-symbol"><Icon name="grid" size={24} /></span><h2>{t('No apps yet')}</h2><p>{t('Apps are small tools your agents build for this room: dashboards, trackers and forms.')}</p><button onClick={() => setCreating(true)}>{t('Build an app')}</button></div>}
      {apps && apps.length > 0 && (
        <div className="hx-app-grid">
          {apps.filter(a => `${a.name} ${a.description}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())).map((a) => (
            <article key={a.id} className="hx-app-tile" data-app={a.id}>
              <button className="hx-app-card-open" aria-label={`${a.name}を開く`} onClick={() => openApp(a.id)} />
              <span className="hx-library-card-heading"><HarnessAppIcon icon={a.icon} /><span><span className="hx-app-name">{a.name}</span><span className="hx-app-rooms">{a.channels?.map(c => c.startsWith('ag:') || c.startsWith('dm:') ? t('Private chat') : c.replace(/^b:/, '')).join(' · ') || t('Apps')}</span></span></span>
              <button className={`hx-app-card-pin ${pins.includes(a.id) ? 'on' : ''}`} aria-label={pins.includes(a.id) ? `${a.name}の固定を解除` : `${a.name}をナビゲーションに固定`} aria-pressed={pins.includes(a.id)} onClick={() => void act('pin', async () => toggle(a.id))}><Icon name="pin" size={14} /></button>
              <HarnessAppPreview app={a} api={api} httpBase={props.httpBase} />
            </article>
          ))}
        </div>
      )}

      {apps && apps.length > 0 && !apps.some(a => `${a.name} ${a.description}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())) && <p className="hx-library-no-results" role="status">該当するアプリがありません。</p>}
      {creating && <>
      <div className="rows-title">{t('Templates')}</div>
      <div className="hx-app-grid">
        {templates.map((tpl) => (
          <button key={tpl.id} className="hx-app-tile template" onClick={() => fromTemplate(tpl.id)} disabled={busy === `tpl:${tpl.id}`}>
            <span className="hx-app-icon"><HarnessAppIcon icon={tpl.icon} /></span>
            <span className="hx-app-name">{t(tpl.name)}</span>
            <span className="hx-app-sub">{t(tpl.description)}</span>
          </button>
        ))}
      </div>
      </>}
    </Shell>
  )
}

function CellInput({ column, value, onSave, wrap = false, width, members=[] }: { column: Column; value: unknown; onSave: (v: unknown) => void; wrap?:boolean; width?:number;members?:Array<{ref:string;name:string}> }) {
  const [draft, setDraft] = useState<string>(value == null ? '' : String(value))
  useEffect(() => { setDraft(value == null ? '' : String(value)) }, [value])
  const textArea=useRef<HTMLTextAreaElement>(null)
  useEffect(()=>{if(textArea.current){textArea.current.style.height='auto';textArea.current.style.height=`${textArea.current.scrollHeight}px`}},[draft,wrap,width])
  if(column.type==='person'&&members.length) return <select className="hx-cell-select" aria-label={column.name} value={String(value??'')} onChange={e=>onSave(e.target.value||null)}><option value="">—</option>{value&&!members.some(m=>m.ref===String(value))?<option value={String(value)}>{String(value)}</option>:null}{members.map(m=><option key={m.ref} value={m.ref}>{m.name}</option>)}</select>
  if(wrap&&['text','person'].includes(column.type)) return <textarea ref={textArea} className="hx-cell-input hx-wrapped-input" rows={1} value={draft} onChange={e=>setDraft(e.target.value)} onBlur={()=>{if(draft!==(value==null?'':String(value)))onSave(draft)}} aria-label={column.name}/>
  if (column.type === 'checkbox') {
    return <input type="checkbox" checked={Boolean(value)} onChange={(e) => onSave(e.target.checked)} aria-label={column.name} />
  }
  if (column.type === 'select') {
    return (
      <select className="hx-cell-select" value={value == null ? '' : String(value)} onChange={(e) => onSave(e.target.value || null)} aria-label={column.name}>
        <option value="">—</option>
        {(column.options || []).map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    )
  }
  const type = column.type === 'number' ? 'number' : column.type === 'date' ? 'date' : column.type === 'email' ? 'email' : column.type === 'url' ? 'url' : 'text'
  return (
    <input
      className="hx-cell-input"
      type={type}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => { if (draft !== (value == null ? '' : String(value))) onSave(draft) }}
      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
      aria-label={column.name}
    />
  )
}

export const AppView: React.FC<HarnessProps & { api: HarnessApi; appId: string; onBack: () => void; initialConversation?: {tableId?:string;rowId?:string}; openConversation?:boolean; floating?:boolean; onSectionChange?:(section:AppSection)=>void; initialSection?:AppSection; initialDraft?:string }> = ({ api, appId, onBack, onClose, httpBase, orgId, sessionToken, initialConversation, openConversation, initialSection, initialDraft, floating=false, onSectionChange }) => {
  const floatApp=useFloatingApp()
  const t = useT()
  const [data, setData] = useState<{ app: App; table: Table; rows: Row[]; views: View[]; canCustomize?: boolean } | null>(null)
  const loadSequence=useRef(0)
  const currentApi=useRef(api);currentApi.current=api
  const [loadedApi,setLoadedApi]=useState<HarnessApi|null>(null)
  const [personal,setPersonal] = useState<PersonalViews>({revision:0,views:[],computed:[],layouts:{}})
  const initializedSection = useRef(false)
  const [viewIndex, setViewIndex] = useState(0)
  const [section, setSection] = useState<'overview' | 'data' | 'settings' | 'custom' | 'backend'>('overview')
  const [search, setSearch] = useState('')
  const [creating,setCreating]=useState(false),[fullscreen,setFullscreen]=useState(false)
  const [chatOpen,setChatOpen]=useState(false)
  const consumedDraft=useRef<string|undefined>(undefined)
  const consumeDraft=()=>{
    if(!initialDraft)return
    consumedDraft.current=initialDraft
    const next=consumeAppDraftHash(location.hash,appId,orgId,initialDraft)
    if(next){history.replaceState(history.state,'',next);window.dispatchEvent(new HashChangeEvent('hashchange'))}
  }
  const [chatScope,setChatScope]=useState<{tableId?:string;rowId?:string}>({})
  const [editingRecord,setEditingRecord]=useState<Row|null>(null)
  const [recordMembers,setRecordMembers]=useState<Array<{ref:string;name:string}>>([])
  useEffect(()=>{if(!creating&&!editingRecord&&!data?.table.columns.some(c=>c.type==='person'))return;let active=true;setRecordMembers([]);void api.members().then(result=>{if(active)setRecordMembers(result.members)},()=>{if(active)setRecordMembers([])});return()=>{active=false}},[creating,editingRecord,api,data?.table.columns])
  useEffect(()=>{if(!fullscreen)return;const exit=(e:KeyboardEvent)=>{if(e.key==='Escape'&&!creating&&!editingRecord){e.stopPropagation();setFullscreen(false)}};document.addEventListener('keydown',exit);return()=>document.removeEventListener('keydown',exit)},[fullscreen,creating,editingRecord])
  const [newColumn, setNewColumn] = useState('')
  const [newColumnType, setNewColumnType] = useState<Column['type']>('text')
  const [versions, setVersions] = useState<Array<{ version: number; note: string | null; createdAt: string }> | null>(null)
  const [room, setRoom] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const { busy, error, act } = useAct()

  const load = useCallback(() => act('load', async () => { const sequence=++loadSequence.current; const [next,preferences] = await Promise.all([api.app(appId),api.personalViews(appId)]); if(sequence!==loadSequence.current)return;setLoadedApi(api);setData(next); setPersonal(preferences); setViewIndex(Math.max(0,[...next.views,...preferences.computed].findIndex(v=>v.id===preferences.activeView))); if (!initializedSection.current) { initializedSection.current = true; setSection(initialSection || (next.app.definition.custom?.published ? 'overview' : 'data')) } }), [api, appId, act, initialSection])
  useEffect(() => { setEditingRecord(null);setCreating(false);setChatScope(initialConversation||{});setChatOpen(Boolean(initialConversation)||Boolean(openConversation));load();return()=>{loadSequence.current++;initializedSection.current=false} }, [load,initialConversation,openConversation])

  const selectSection=(next:AppSection)=>{setSection(next);onSectionChange?.(next);const hash=appSectionHash(location.hash,appId,orgId,next);if(!floating&&hash&&hash!==location.hash)location.hash=hash}
  if (!data || loadedApi!==api) return <Shell title={t('Apps')} onClose={onBack} nested>{error ? <div className="form-error">{error}</div> : <div className="empty">{t('Loading…')}</div>}</Shell>
  const { app, table } = data
  const allViews = [...data.views,...personal.computed]
  const view = allViews[Math.min(viewIndex, allViews.length - 1)]
  const savePersonal = async (next:PersonalViews) => {const saved=await api.savePersonalViews(appId,next);if(currentApi.current!==api)return;setPersonal(saved);setViewIndex(Math.max(0,[...data.views,...saved.computed].findIndex(v=>v.id===saved.activeView)))}
  const canEditView=view.id.startsWith('personal_') || data.canCustomize !== false
  const saveView = async (patch:Partial<View>) => { if(view.id.startsWith('personal_')) { await savePersonal({...personal,views:personal.views.map(v=>v.id===view.id?{...v,...patch}:v)}); return } await api.updateApp(app.id, { expectedVersion: app.version, definition: { ...app.definition, views: app.definition.views.map(v => v.id === view.id ? {...v,...patch} : v) }, note: 'ビューのフィルター・並べ替え・グループを更新' }); await load() }
  const layout = displayLayout(table.columns,personal.layouts[view.id])
  const orderedColumns = [...(layout?.order || []),...layout.columns.map(c=>c.id)].filter((id,i,ids)=>ids.indexOf(id)===i).map(id=>layout.columns.find(c=>c.id===id)).filter((c):c is Column=>!!c)
  const displayColumns = orderedColumns.filter(c=>c.id===table.columns[0]?.id || !layout?.hidden?.includes(c.id))
  const shownRows = (view.rows || []).filter(row => !search || table.columns.some(c => cellText(c, row.values[c.id]).toLowerCase().includes(search.toLowerCase())))

  const save = (row: Row, column: Column, value: unknown) => act(`cell:${row.id}`, async () => {
    await api.updateRow(table.id, row.id, { [column.id]: value }, row.updatedAt)
    await load()
  })
  const addRow = () => setCreating(true)
  const removeRow = (row: Row) => act(`del:${row.id}`, async () => { await api.deleteRow(table.id, row.id, row.updatedAt); await load() })

  return (
    <Shell
      className={`hx-resource-screen hx-app-detail${chatOpen?' hx-app-with-chat':''}${fullscreen?' hx-app-fullscreen':''}`}
      title={<span className="hx-app-title"><HarnessAppIcon icon={app.icon} size={16} /><button onClick={() => selectSection(app.definition.custom?.published ? 'overview' : 'data')}>{app.name}</button>{section !== 'overview' && <span className="hx-app-breadcrumb">/ {t(section === 'data' ? 'Data viewer' : section === 'custom' ? 'Customize app' : section === 'backend' ? '実行基盤' : 'Settings')}</span>}<button className="hx-app-icon-button" aria-label="データを更新" disabled={busy!==null} onClick={()=>void load()}><Icon name="refresh" size={14}/></button></span>}
      onClose={onBack}
      nested
      actions={<><button className="pill-btn quiet" onClick={() => selectSection('custom')}><Icon name="grid" size={14} />{t('Customize app')}</button><button className="pill-btn quiet" onClick={() => selectSection('settings')}><Icon name="share" size={14} />{t('Sharing')}</button><AppConversationInbox api={api} appId={app.id} onOpen={scope=>{setChatScope(scope);setChatOpen(true)}}/><button className="hx-app-icon-button" aria-label={chatOpen?'アプリチャットを閉じる':'アプリチャットを開く'} aria-pressed={chatOpen} onClick={()=>{setChatScope({});setChatOpen(!chatOpen)}}><Icon name="message" size={16}/></button><button className="hx-app-icon-button" aria-label={fullscreen?'全画面表示を終了':'全画面表示'} aria-pressed={fullscreen} onClick={()=>setFullscreen(!fullscreen)}><Icon name={fullscreen?'minimize':'maximize'} size={16}/></button><HarnessAppMenu api={api} appId={app.id} orgId={orgId} onSection={selectSection} onFloat={!floating&&floatApp&&['overview','data'].includes(section)?()=>{floatApp(app.id,section);onClose()}:undefined} /><button className="hx-app-icon-button" aria-label={floating?'フローティングアプリを閉じる':'パネルを閉じる'} onClick={onClose}><Icon name="x" size={16}/></button></>}
    >
      {chatOpen&&<AppConversationPanel key={`${orgId}:${app.id}:${chatScope.rowId||"app"}`} api={api} appId={app.id} {...chatScope} title={chatScope.rowId?"レコードチャット":app.name} initialDraft={chatScope.rowId||consumedDraft.current===initialDraft?undefined:initialDraft} onInitialDraftConsumed={consumeDraft} context={chatScope.rowId?(cellText(table.columns[0],data.rows.find(r=>r.id===chatScope.rowId)?.values[table.columns[0].id])||'選択したレコード'):section==='data'?`現在のデータ表示: ${view.name}`:undefined} onClose={()=>setChatOpen(false)}/>}
      <div className="hx-app-main">
      {section !== 'overview' && section !== 'data' && <nav className="hx-app-sections" aria-label={t('App sections')}>{(['overview', 'data', 'custom', 'backend', 'settings'] as const).map(tab => <button key={tab} aria-current={section === tab ? 'page' : undefined} className={section === tab ? 'on' : ''} onClick={() => selectSection(tab)}>{t(tab === 'overview' ? 'Overview' : tab === 'data' ? 'Data viewer' : tab === 'custom' ? 'Customize app' : tab === 'backend' ? '実行基盤' : 'Settings')}</button>)}</nav>}
      {creating&&<AppRecordDialog appName={app.name} columns={table.columns} members={recordMembers} save={async values=>{await api.addRow(table.id,values,'strict');await load()}} onClose={()=>setCreating(false)}/>}
      {editingRecord&&<AppRecordDialog key={editingRecord.id} appName={app.name} columns={table.columns} members={recordMembers} record={editingRecord} conversation={<AppConversationPanel key={`${orgId}:${app.id}:${editingRecord.id}`} api={api} appId={app.id} tableId={table.id} rowId={editingRecord.id} title="レコードチャット" context={cellText(table.columns[0],editingRecord.values[table.columns[0].id])||editingRecord.id}/>} save={async values=>{if(Object.keys(values).length)await api.updateRow(table.id,editingRecord.id,values,editingRecord.updatedAt);await load()}} onClose={()=>setEditingRecord(null)}/>}
      {section === 'backend' && <CompanyApp app={app} api={api} canManage={data.canCustomize !== false} reload={load} />}
      {section === 'custom' && data.canCustomize === false && <p>カスタムコードの編集・公開は、作成者または管理者が行えます。</p>}
      {section === 'custom' && data.canCustomize !== false && <CustomAppEditor httpBase={httpBase} app={app} table={table} rows={data.rows} api={api} reload={load} />}
      {section === 'overview' && app.definition.custom?.published && <CustomAppFrame appId={app.id} api={api} reload={load} httpBase={httpBase} html={app.definition.custom.published} table={table} rows={data.rows} />}
      {section === 'overview' && !app.definition.custom?.published && <div className="hx-app-overview"><span className="hx-resource-symbol"><Icon name="grid" size={24} /></span><h2>{t('Database app')}</h2><p>{app.description || t('Browse and manage this app’s data in the data viewer.')}</p><div className="hx-actions"><button className="pill-btn" onClick={() => selectSection('data')}>{t('Browse data')}</button><button className="pill-btn quiet" onClick={() => selectSection('custom')}>{t('Customize app')}</button></div><small>{t('{n} records', { n: data.rows.length })} · {table.columns.length} {t('Fields')}</small></div>}
      {section === 'data' && <>
      <div className="hx-data-toolbar"><div className="hx-data-heading"><h2>{table.name}</h2><button className="pill-btn" onClick={addRow} disabled={busy !== null}><Icon name="plus" size={14} />新規レコード</button></div>
      <div className="hx-data-tools"><input className="hx-cell-input" type="search" aria-label={t('Search records')} placeholder={t('Search records')} value={search} onChange={e => setSearch(e.target.value)} /><PersonalViewControls control="fields" key={`${view.id}:${personal.revision}`} view={view} columns={table.columns} state={personal} save={savePersonal} onSelect={()=>{}} onSettings={()=>selectSection('settings')} /><AppViewControls key={`${view.id}:${app.version}:${personal.revision}`} view={view} columns={table.columns} personal={view.id.startsWith('personal_')} onAdjust={view.id.startsWith('personal_')?undefined:kind=>{location.hash=hashForAppSource(app.id,orgId,'data',`「${app.name}」（${table.name}）のデータビューアーのビュー「${view.name}」の${kind==='filter'?'フィルター':'グループ化'}を調整：`.slice(0,1000))}} canEdit={view.id.startsWith('personal_') || data.canCustomize !== false} save={saveView} />{view.type==='table'&&<AppDataMenu wrapText={layout.wrapText===true} save={wrapText=>savePersonal({...personal,layouts:{...personal.layouts,[view.id]:{order:layout.order,widths:layout.widths,hidden:layout.hidden,wrapText}}})}/>}<span>{t('{n} records', { n: view.type==='table'?shownRows.length:data.rows.length })}</span></div>
      <div className="hx-tabs" role="tablist">
        {allViews.map((v, i) => (
          <button key={v.id} role="tab" aria-selected={i === viewIndex} className={i === viewIndex ? 'on' : ''} onClick={() => {setViewIndex(i);void act('view',()=>savePersonal({...personal,activeView:v.id}))}}>
            <Icon name={v.type === 'board' ? 'grid' : v.type === 'metrics' ? 'insights' : v.type === 'calendar' ? 'calendar' : 'list'} size={14} /> {v.name}{v.id.startsWith('personal_') && <small className="hx-personal-badge">個人</small>}
          </button>
        ))}
        <PersonalViewControls control="view" key={`new:${view.id}:${personal.revision}`} view={view} columns={table.columns} state={personal} save={savePersonal} onSelect={()=>{}} onSettings={()=>selectSection('settings')} />
      </div>
      </div>
      {error && <div className="form-error">{error}</div>}
      {data.canCustomize !== false && app.definition.views.length < 12 && !data.views.some(v => v.type === 'calendar') && table.columns.some(c => c.type === 'date') && <button className="pill-btn quiet" disabled={busy !== null} onClick={() => act('calendar', async () => {
        await api.updateApp(app.id, { definition: { ...app.definition, views: [...app.definition.views, { type: 'calendar', name: t('Calendar'), dateColumn: table.columns.find(c => c.type === 'date')!.id }] } })
        await load()
      })}>{t('Add calendar view')}</button>}

      {view.type === 'calendar' && <AppCalendar key={view.id} view={view} table={table} onOpen={setEditingRecord} onMove={(row, date) => { const column = table.columns.find(c => c.id === view.dateColumn); if (column) void save(row, column, date) }} />}

      {view.type === 'metrics' && (
        <div className="hx-metrics">
          {(view.values || []).map((m) => (
            <div className="hx-metric" key={m.label}>
              <span className="hx-metric-value">{metricText(m)}</span>
              <span className="hx-metric-label">{m.label}</span>
            </div>
          ))}
        </div>
      )}

      {view.type === 'board' && (
        <div className="hx-board">
          {(view.lanes || []).map((lane) => (
            <div className="hx-lane" key={lane.key ?? '—'}>
              <div className="hx-lane-head">{lane.key ?? t('No value')} <span className="hx-count">{lane.rows.length}</span></div>
              {lane.rows.map((row) => {
                const groupCol = table.columns.find((c) => c.id === view.groupBy)
                const title = table.columns[0]
                return (
                  <div className="hx-card" key={row.id}>
                    <button className="hx-card-title hx-record-title" onClick={()=>setEditingRecord(row)} aria-label={`${title ? cellText(title,row.values[title.id]) || '無題' : row.id}の詳細を開く`}>{title ? cellText(title, row.values[title.id]) || '—' : row.id}<Icon name="maximize" size={13}/></button>
                    {table.columns.slice(1, 4).filter((c) => c.id !== view.groupBy && row.values[c.id] != null).map((c) => (
                      <div className="hx-card-field" key={c.id}><span>{c.name}</span> {cellText(c, row.values[c.id])}</div>
                    ))}
                    {groupCol && <CellInput column={groupCol} value={row.values[groupCol.id]} onSave={(v) => save(row, groupCol, v)} />}
                  </div>
                )
              })}
            </div>
          ))}
        </div>
      )}

      {view.type === 'table' && (
        <div className="hx-table-wrap">
          <table className={`hx-table hx-personal-table${layout.wrapText?' hx-wrap-text':''}`} style={{width:displayColumns.reduce((n,c)=>n+(layout?.widths[c.id]||180),80)}}>
            <colgroup>{displayColumns.map(c=><col key={c.id} style={{width:layout?.widths[c.id]||180}}/>)}<col style={{width:80}}/></colgroup>
            <thead>
              <tr>{displayColumns.map((c) => <th key={c.id} aria-sort={view.sort===c.id?'ascending':view.sort===`-${c.id}`?'descending':'none'}><button className="hx-column-sort" disabled={!canEditView||busy!==null} aria-label={`${c.name}で${view.sort===c.id?'降順に並べ替え':view.sort===`-${c.id}`?'並べ替えを解除':'昇順に並べ替え'}`} onClick={()=>void act('sort',()=>saveView({sort:nextColumnSort(view.sort,c.id)}))}>{c.name}<Icon name={view.sort===c.id?'arrow-up':view.sort===`-${c.id}`?'arrow-down':'sort'} size={12}/></button><ColumnResize name={c.name} width={layout?.widths[c.id]||180} save={width=>act('layout',()=>savePersonal({...personal,layouts:{...personal.layouts,[view.id]:{...personal.layouts[view.id],hidden:layout.hidden,order:orderedColumns.map(c=>c.id),widths:{...layout?.widths,[c.id]:width}}}}))}/></th>)}<th aria-label={t('Actions')} /></tr>
            </thead>
            <tbody>
              {(view.groupBy ? (view.lanes || []).map(lane=>({...lane,rows:lane.rows.filter(row=>shownRows.some(r=>r.id===row.id))})) : [{key:null,rows:shownRows}]).map((group,groupIndex)=><React.Fragment key={group.key ?? groupIndex}>
              {view.groupBy && <tr className="hx-table-group"><th colSpan={displayColumns.length+1}>{group.key ?? '未設定'} <span className="hx-count">{group.rows.length}</span></th></tr>}
              {group.rows.map((row) => (
                <tr key={row.id} data-row={row.id}>
                  {displayColumns.map((c) => (
                    <td key={c.id}>{isSystemColumn(c.id)?<span className="hx-system-cell" title={c.id==='$row.id'?row.id:c.id==='$row.createdAt'?row.createdAt:row.updatedAt}>{systemCellText(row,c.id)}</span>:<CellInput members={recordMembers} width={layout.widths[c.id]||180} wrap={layout.wrapText===true} column={c} value={row.values[c.id]} onSave={(v) => save(row, c, v)} />}</td>
                  ))}
                  <td><div className="hx-record-actions"><button className="hx-app-icon-button" aria-label={`${cellText(table.columns[0],row.values[table.columns[0].id])||'無題'}の詳細を開く`} onClick={()=>setEditingRecord(row)}><Icon name="maximize" size={14}/></button><button className="btn-text danger" onClick={() => removeRow(row)} disabled={busy === `del:${row.id}`} aria-label={t('Delete row')}><Icon name="trash" size={14} /></button></div></td>
                </tr>
              ))}</React.Fragment>)}
            </tbody>
          </table>
          {shownRows.length === 0 && <div className="hx-table-empty"><strong>レコードがありません</strong><span>この表示に一致するレコードはありません。</span></div>}
        </div>
      )}
      {view.type !== 'metrics' && <button className="pill-btn quiet hx-add" onClick={addRow} disabled={busy === 'add'}><Icon name="plus" size={14} /> {t('Add a row')}</button>}

      </>}
      {section === 'settings' && <>
      <h2>{t('Fields')}</h2><div className="rows">{table.columns.map(column => <div className="row static" key={column.id}><span className="row-main">{column.name}</span><span className="row-sub">{column.type}</span></div>)}</div>
      {data.canCustomize !== false && <form className="hx-actions" onSubmit={event => { event.preventDefault(); void act('column', async () => { await api.updateApp(app.id, { columns: [...table.columns, { name: newColumn.trim(), type: newColumnType }] }); setNewColumn(''); await load() }) }}><input className="hx-cell-input" aria-label={t('Field name')} placeholder={t('Field name')} value={newColumn} onChange={e => setNewColumn(e.target.value)} /><select aria-label={t('Field type')} value={newColumnType} onChange={e => setNewColumnType(e.target.value as Column['type'])}>{(['text', 'number', 'date', 'checkbox', 'person', 'email', 'url'] as const).map(type => <option key={type} value={type}>{type}</option>)}</select><button className="pill-btn" disabled={busy !== null || !newColumn.trim()}>{t('Add field')}</button></form>}
      <AppSharing key={`${httpBase}:${orgId}:${appId}:${sessionToken}`} httpBase={httpBase} orgId={orgId} sessionToken={sessionToken} appId={appId} />

      <div className="rows-title">{t('Rooms')}</div>
      <div className="rows">
        <div className="row static">
          <span className="row-main">
            {(app.channels || []).length ? (app.channels || []).map((c) => (
              <span key={c} className="hx-chip">{c.startsWith('ag:') || c.startsWith('dm:') ? t('Private chat') : c.replace(/^b:/, '#')}<button className="btn-text" onClick={() => act('unlink', async () => { await api.unlink(app.id, c); await load() })} aria-label={t('Remove')}>×</button></span>
            )) : <span className="row-sub">{t('Link it to a room and it shows there, next to the conversation.')}</span>}
            <span className="playbook-add-foot">
              <input className="hx-cell-input" value={room} onChange={(e) => setRoom(e.target.value)} placeholder="#ops" aria-label={t('Room')} />
              <button className="pill-btn" disabled={!room.trim()} onClick={() => act('link', async () => { await api.link(app.id, `b:${room.replace(/^#/, '').trim()}`); setRoom(''); await load() })}>{t('Link')}</button>
            </span>
          </span>
        </div>
      </div>

      <div className="rows-title">{t('Versions')}</div>
      <div className="rows">
        {versions === null ? (
          <button className="row" onClick={() => act('versions', async () => setVersions((await api.versions(app.id)).versions))}>
            <span className="row-icon"><Icon name="history" size={18} /></span>
            <span className="row-main">{t('Show version history')}</span>
          </button>
        ) : versions.map((v) => (
          <div className="row static" key={v.version}>
            <span className="row-main">v{v.version}{v.note ? ` · ${v.note}` : ''}<span className="row-sub">{new Date(v.createdAt).toLocaleString()}</span></span>
            {data.canCustomize !== false && v.version !== app.version && <button className="btn-text" onClick={() => act('restore', async () => { await api.restore(app.id, v.version); setVersions(null); await load() })}>{t('Restore')}</button>}
          </div>
        ))}
      </div>

      <div className="rows">
        {confirmDelete ? (
          <div className="row static">
            <span className="row-main">{t('Delete this app and all its rows?')}</span>
            <span className="team-confirm">
              <button className="pill-btn" onClick={() => act('delete', async () => { await api.deleteApp(app.id); onBack() })}>{t('Delete')}</button>
              <button className="btn-text" onClick={() => setConfirmDelete(false)}>{t('Keep')}</button>
            </span>
          </div>
        ) : (
          <button className="row" onClick={() => setConfirmDelete(true)}><span className="row-main hx-danger">{t('Delete app')}</span></button>
        )}
      </div>
      </>}
      {section !== 'data' && error && <div className="form-error" role="alert">{error}</div>}
      </div>
    </Shell>
  )
}

// ── Approvals ───────────────────────────────────────────────────────────

export const HarnessApprovals: React.FC<HarnessProps> = (props) => {
  const t = useT()
  const api = useApi(props)
  const [data, setData] = useState<Awaited<ReturnType<HarnessApi['approvals']>> | null>(null)
  const { error, act } = useAct()
  useEffect(() => { act('load', async () => setData(await api.approvals())) }, [api, act])
  return (
    <Shell title={t('Approvals')} onClose={props.onClose}>
      <p className="lede">{t('Agents propose, people approve. Everything an agent or a workflow is waiting on you for, in one place.')}</p>
      {error && <div className="form-error">{error}</div>}
      <div className="rows-title">{t('Waiting on you')}</div>
      {data === null && <div className="empty">{t('Loading…')}</div>}
      {data?.toDecide.length === 0 && <div className="empty">{t('Nothing is waiting on you.')}</div>}
      <div className="rows">
        {data?.toDecide.map((c) => (
          <a key={c.id} className="row" href={hashForCard(c.id)} data-card={c.id}>
            <span className="row-icon"><Icon name={c.kind === 'workflow' ? 'zap' : 'sparkle'} size={18} /></span>
            <span className="row-main">{c.title}<span className="row-sub">{[c.source, c.summary].filter(Boolean).join(' · ')}</span></span>
            <span className="row-value">›</span>
          </a>
        ))}
      </div>
      <div className="rows-title">{t('Waiting on others')}</div>
      {data?.waitingOnOthers.length === 0 && <div className="empty">{t('No workflow of yours is waiting on anyone.')}</div>}
      <div className="rows">
        {data?.waitingOnOthers.map((w) => (
          <div key={w.runId} className="row static">
            <span className="row-icon"><Icon name="clock" size={18} /></span>
            <span className="row-main">{w.workflow}<span className="row-sub">{t('Started {when}', { when: new Date(w.startedAt).toLocaleString() })}</span></span>
          </div>
        ))}
      </div>
    </Shell>
  )
}
