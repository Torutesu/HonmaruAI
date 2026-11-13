import { useFloatingApp } from '../components/FloatingAppContext'
import {AppConversationInbox} from '../components/AppConversationInbox'
import {AppConversationPanel} from '../components/AppConversationPanel'
import {AppAnnotationDialog, AppAnnotationLayer, AppAnnotationList, AppAnnotationMarkers, type AppAnnotationSelection} from '../components/AppAnnotation'
import {AppRecordDialog} from '../components/AppRecordDialog'
import {AppRowDeleteConfirm} from '../components/AppRowDeleteConfirm'
import { AppRowActions } from '../components/AppRowActions'
import {AppDataMenu} from '../components/AppDataMenu'
import {AppDataCell,relationOptionLabel,type RelationEntity} from '../components/AppDataCell'
import {csvText, downloadCsv, downloadXlsx, serializeRowsToXlsx} from '../utils/csvExport'
import {displayLayout, fitTableColumns, isSystemColumn, systemCellText, systemDateFormatter, nextColumnSort} from '../utils/systemColumns'
import { ColumnResize } from '../components/ColumnResize'
import { PersonalViewControls } from '../components/PersonalViewControls'
import type { PersonalViews } from '../utils/harness'
import { AppViewControls } from '../components/AppViewControls'
import { HarnessAppPreview } from '../components/HarnessAppPreview'
import { AppViewportPreview } from '../components/AppViewportPreview'
import { DatabaseAppPreview } from '../components/DatabaseAppPreview'
import { HarnessAppMenu } from '../components/HarnessAppMenu'
import { useAppPins } from '../utils/appPins'
import { HarnessAppIcon } from '../components/HarnessAppIcon'
import { CompanyApp } from '../components/CompanyApp'
import { CustomAppEditor, CustomAppFrame } from "../components/CustomApp"
import { AppSharing } from '../components/AppSharing'
import { ExternalAppSharing } from '../components/ExternalAppSharing' 
import { TemplateSharing } from '../components/TemplateSharing'
import { AppCalendar } from '../components/AppCalendar'
import { RemoteMcpServers } from '../components/RemoteMcpServers'
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useT } from '../utils/i18n'
import { Icon } from '../components/Icon'
import { hashForApp, hashForAppSource, hashForCard, consumeAppDraftHash, appSectionHash, type AppSection } from '../utils/route'
import {
  useWorkspaceMode, cellText, metricText, WANT_MODE_KEY, SET_MODE_EVENT, isMode, HarnessApiError, type WorkspaceMode,
  type App, type AppAnnotation, type AppAnnotationMeta, type Template, type Table, type Row, type View, type Column, type HarnessApi,
} from '../utils/harness'
import { Shell, useApi, useAct, type HarnessProps, type HarnessScreen } from './HarnessShared'
import { ModePicker } from './HarnessHome'
import { composing } from '../utils/keys'

export const newAppRecordLabel = (appName: string, tableName: string, titleColumnName = '') => {
  if (tableName && tableName !== appName) return `新規${tableName}`
  const title = titleColumnName.trim()
  if (/^(?:名前|氏名|名称|件名|タイトル|タイトル名|title|name)$/iu.test(title)) return '新規レコード'
  const titleNoun = title.replace(/(?:タイトル|名)$/u, '').trim()
  return titleNoun ? `新規${titleNoun}` : '新規レコード'
}

export const appTableDisplayName = (appName: string, tableName: string, titleColumnName = '') => {
  if (tableName && tableName !== appName) return tableName
  const createLabel = newAppRecordLabel(appName, tableName, titleColumnName)
  return createLabel === '新規レコード' ? tableName || appName : createLabel.slice('新規'.length)
}

export const shouldShowRecordCount = (count: number, query: string, activeFilters: number) =>
  count > 0 || query.trim().length > 0 || activeFilters > 0

// Reopen an App's readable creation conversation so a person can describe
// changes in their own words. Missing or inaccessible source threads fall
// back to the existing in-app editor.
export async function appCustomizeSourceHash(api: Pick<HarnessApi, 'conversation'>, appId: string, orgId: string): Promise<string | null> {
  try {
    const source = (await api.conversation(appId)).source
    if (!source?.threadId || !source.messages.some(message => String(message.id) === String(source.threadId))) return null
    return hashForAppSource(appId, orgId)
  } catch {
    return null
  }
}

// The harness screens (docs/kylon-gap-plan.md): Apps, Workflows, Approvals,
// Skills and agents as members, and the hub that switches a workspace into
// harness mode. Nothing here is reached from a simple workspace except the
// hub's switch, so the feed and the chat stay what they were.

// ── Hub ─────────────────────────────────────────────────────────────────

export const HarnessHub: React.FC<HarnessProps & { onOpen: (s: HarnessScreen) => void }> = (props) => {
  const t = useT()
  const { mode, workspaceMode, canEdit, loaded, setMode, simpleOnly, setSimpleOnly, preferenceError } = useWorkspaceMode(props.httpBase, props.orgId, props.sessionToken)
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
          <input type="checkbox" checked={simpleOnly} onChange={e => { void setSimpleOnly(e.target.checked).catch(() => {}) }} />
          <span className="row-main">{t('Use only Simple on all your devices')}<span className="row-sub">{t('Only your view changes. Shared apps and workflows stay saved; other members are unaffected.')}</span></span>
        </label>
        {preferenceError && <div className="form-error">{t('Could not sync your Simple preference. Your choice is saved on this device.')}</div>}
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
  const [storedOpenApp] = useState<string | null>(() => {
    try { const id = sessionStorage.getItem('hx.openApp'); sessionStorage.removeItem('hx.openApp'); return id } catch { return null }
  })
  // An app opened from a room's details (RoomApps) arrives already open.
  const [open, setOpen] = useState<string | null>(() => {
    if (props.requestedAppId) return props.requestedAppId
    return storedOpenApp
  })
  const [prompt, setPrompt] = useState('')
  const [sampleCount, setSampleCount] = useState(0)
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
  const openApp = (id: string) => { setOpen(id); location.hash = hashForApp(id, props.orgId, undefined, 'data') }
  if (open) return <AppView key={open} {...props} initialSection={props.initialSection || (storedOpenApp === open ? 'data' : undefined)} api={api} appId={open} onBack={() => { setOpen(null); location.hash = '#/apps'; load() }} />

  const generate = () => act('generate', async () => {
    const startingHash = location.hash
    const submittedPrompt = prompt
    const room = prompt.match(/#([\p{L}\p{N}_-]+)/u)?.[1]
    const key = JSON.stringify([props.orgId,prompt,room,sampleCount])
    if (generationRequest.current?.key !== key) generationRequest.current = {key,id:crypto.randomUUID()}
    const requestId = generationRequest.current.id
    let made: Awaited<ReturnType<typeof api.generate>>
    try {
      made = await api.generate(prompt, room ? `b:${room}` : undefined, {requestId,captureSource:Boolean(room),sampleCount})
    } catch (error) {
      if (error instanceof HarnessApiError && error.status === 409 && error.code === 'APP_GENERATION_OBSOLETE_UNPUBLISHED' && generationRequest.current?.id === requestId) generationRequest.current = null
      throw error
    }
    if (liveApi.current !== api) return
    generationRequest.current = null
    setSampleCount(0)
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
  const appLabel = (key:string,name:string) => t(key).replaceAll('{name}',()=>name)

  return (
    <Shell className="hx-resource-screen hx-app-library" title={t('Apps')} onClose={props.onClose} actions={<button className="pill-btn" onClick={() => setCreating(v => !v)}>{t(creating ? 'Cancel' : 'Build an app')}</button>}>
      {creating && <>
      <div className="rows">
        <div className="row static">
          <div className="row-main">
            {t('Describe an app')}
            <textarea
              className="context-input"
              rows={2}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={t('e.g. An invoice tracker for #ops, from the billing inbox')}
              aria-label={t('Describe an app')}
            />
            <details className="hx-app-sample-options">
              <summary>{t('Initial data')} · {sampleCount === 0 ? t('Empty') : t('Up to {n} sample rows',{n:sampleCount})}</summary>
              <label>{t('Maximum sample rows')}
                <select aria-label={t('Maximum sample rows')} value={sampleCount} disabled={busy === 'generate'} onChange={e => setSampleCount(Number(e.target.value))}>
                  {Array.from({length:21},(_,count)=><option key={count} value={count}>{count}</option>)}
                </select>
              </label>
              <span className="row-sub">{t('Set this separately from your description. Zero starts with an empty table; sample rows are real records.')}</span>
            </details>
            {sampleCount === 0 && /(?:サンプル|見本|ダミー)(?:データ|レコード|行)|\b(?:sample|example|dummy)\s+(?:data|rows?|records?|entries)\b/iu.test(prompt) && <span className="row-sub" role="status">{t('To include sample rows, choose a limit under Initial data.')}</span>}
            <span className="playbook-add-foot">
              <span className="row-sub">{t('Your AI designs the table and its views.')}</span>
              <button className="pill-btn" onClick={generate} disabled={busy === 'generate' || !prompt.trim()}>{busy === 'generate' ? t('Building…') : t('Build')}</button>
            </span>
          </div>
        </div>
      </div>
      </>}
      {note && <div className="form-note">{note}</div>}
      {error && <div className="form-error">{error}</div>}

      <RemoteMcpServers httpBase={props.httpBase} orgId={props.orgId} sessionToken={props.sessionToken} />

      <label className="hx-library-search"><Icon name="search" size={16} /><input type="search" aria-label={t('Search apps')} placeholder={t('Search apps')} value={query} onChange={e => setQuery(e.target.value)} /></label>
      {apps === null && <div className="empty">{t('Loading…')}</div>}
      {apps?.length === 0 && !creating && <div className="hx-resource-empty"><span className="hx-resource-symbol"><Icon name="grid" size={24} /></span><h2>{t('No apps yet')}</h2><p>{t('Apps are small tools your agents build for this room: dashboards, trackers and forms.')}</p><button onClick={() => setCreating(true)}>{t('Build an app')}</button></div>}
      {apps && apps.length > 0 && (
        <div className="hx-app-grid">
          {apps.filter(a => `${a.name} ${a.description}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())).map((a) => (
            <article key={a.id} className="hx-app-tile" data-app={a.id}>
              <button className="hx-app-card-open" aria-label={appLabel('Open {name}',a.name)} onClick={() => openApp(a.id)} />
              <span className="hx-library-card-heading"><HarnessAppIcon icon={a.icon} /><span><span className="hx-app-name">{a.name}</span><span className="hx-app-rooms">{a.channels?.map(c => c.startsWith('ag:') || c.startsWith('dm:') ? t('Private chat') : c.replace(/^b:/, '')).join(' · ') || t('Apps')}</span></span></span>
              <button className={`hx-app-card-pin ${pins.includes(a.id) ? 'on' : ''}`} aria-label={appLabel(pins.includes(a.id) ? 'Unpin {name} from navigation' : 'Pin {name} to navigation',a.name)} aria-pressed={pins.includes(a.id)} onClick={() => void act('pin', async () => toggle(a.id))}><Icon name="pin" size={14} /></button>
              <HarnessAppPreview app={a} api={api} httpBase={props.httpBase} />
            </article>
          ))}
        </div>
      )}

      {apps && apps.length > 0 && !apps.some(a => `${a.name} ${a.description}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())) && <p className="hx-library-no-results" role="status">{t('No apps match your search.')}</p>}
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

export function HarnessTemplateImport({ httpBase, orgId, sessionToken, onClose, token }: HarnessProps & { token: string }) {
  const t = useT()
  const api = useApi({ httpBase, orgId, sessionToken, onClose })
  const [result, setResult] = useState<Awaited<ReturnType<HarnessApi['sharedTemplate']>> | null>(null)
  const [importedApp, setImportedApp] = useState<App | null>(null)
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    const controller = new AbortController()
    setResult(null); setError('')
    void api.sharedTemplate(token, controller.signal).then(setResult).catch(err => { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : String(err)) })
    return () => controller.abort()
  }, [api, token])
  const snapshot = result?.snapshot
  const importTemplate = async () => {
    setBusy(true); setError('')
    try {
      const imported = await api.importSharedTemplate(token, name.trim() || undefined)
      setImportedApp(imported.app)
    } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
    finally { setBusy(false) }
  }
  return <Shell className="hx-resource-screen hx-template-import" title={t('Import template')} onClose={onClose}>
    {error && <div className="form-error" role="alert">{error}</div>}
    {!result && !error && <div className="empty">{t('Loading…')}</div>}
    {snapshot && <>
      <div className="hx-template-import-card">
        <HarnessAppIcon icon={snapshot.app.icon} size={24} />
        <div><h2>{snapshot.app.name}</h2><p>{snapshot.app.description || t('A reusable app structure.')}</p></div>
      </div>
      <p className="hx-hint">{t('Version {n} · expires {date}', { n: snapshot.version, date: new Date(result.expiresAt).toLocaleString() })}</p>
      <div className="rows-title">{t('Included structure')}</div>
      <div className="rows">
        <div className="row static"><span className="row-main">{t('Primary table')}<span className="row-sub">{snapshot.tableName}</span></span></div>
        <div className="row static"><span className="row-main">{t('Fields')}<span className="row-sub">{snapshot.columns.map(column => `${column.name} · ${column.type}`).join('  /  ')}</span></span></div>
        <div className="row static"><span className="row-main">{t('Views')}<span className="row-sub">{snapshot.definition.views.map(view => view.name).join(' · ')}</span></span></div>
      </div>
      <p className="hx-hint">{t('Records, custom code, connections and secrets are not imported.')}</p>
      {importedApp ? <div className="hx-template-import-success" role="status"><strong>{t('Template imported.')}</strong><div className="hx-actions"><button className="pill-btn" onClick={() => { location.hash = hashForApp(importedApp.id, orgId) }}>{t('Open in Apps')}</button><button className="pill-btn quiet" onClick={onClose}>{t('Done')}</button></div></div> : <>
        <label className="hx-template-import-name">{t('Name this app')}<input className="hx-cell-input" value={name} placeholder={snapshot.app.name} maxLength={80} onChange={event => setName(event.target.value)} /></label>
        <div className="hx-actions"><button className="pill-btn" disabled={busy} onClick={() => void importTemplate()}>{busy ? t('Importing…') : t('Import template')}</button><span className="hx-hint">{t('The app will be added to the selected workspace.')}</span></div>
      </>}
    </>}
  </Shell>
}

export const AppView: React.FC<HarnessProps & { api: HarnessApi; appId: string; onBack: () => void; initialConversation?: {tableId?:string;rowId?:string}; openConversation?:boolean; floating?:boolean; floatingCompact?:boolean; onSectionChange?:(section:AppSection)=>void; initialSection?:AppSection; initialDraft?:string }> = ({ api, appId, onBack, onClose, httpBase, orgId, sessionToken, initialConversation, openConversation, initialSection, initialDraft, floating=false, floatingCompact=false, onSectionChange }) => {
  const floatApp=useFloatingApp()
  const t = useT()
  const [data, setData] = useState<{ app: App; table: Table; rows: Row[]; views: View[]; canCustomize?: boolean } | null>(null)
  const [snapshotPending,setSnapshotPending]=useState(false)
  const [relationEntities,setRelationEntities]=useState<RelationEntity[]>([])
  const [tableAvailableWidth,setTableAvailableWidth]=useState(0)
  const tableResizeCleanup=useRef<(()=>void)|null>(null)
  const tableWrapRef=useCallback((node:HTMLDivElement|null)=>{
    tableResizeCleanup.current?.();tableResizeCleanup.current=null
    if(!node)return
    const measure=()=>setTableAvailableWidth(Math.max(0,Math.floor(node.clientWidth)))
    measure()
    if(typeof ResizeObserver!=='undefined'){
      const observer=new ResizeObserver(measure);observer.observe(node);tableResizeCleanup.current=()=>observer.disconnect()
    }else{
      window.addEventListener('resize',measure);tableResizeCleanup.current=()=>window.removeEventListener('resize',measure)
    }
  },[])
  useEffect(()=>()=>tableResizeCleanup.current?.(),[])
  const loadSequence=useRef(0)
  const currentApi=useRef(api);currentApi.current=api
  const currentAppId=useRef(appId);currentAppId.current=appId
  const [loadedApi,setLoadedApi]=useState<HarnessApi|null>(null)
  const [personal,setPersonal] = useState<PersonalViews>({revision:0,views:[],computed:[],layouts:{}})
  const personalSnapshot=useRef<{api:HarnessApi;appId:string;value:PersonalViews}|null>(null)
  const initializedSection = useRef(false)
  const [viewIndex, setViewIndex] = useState(0)
  const [focusSelectedView,setFocusSelectedView] = useState(false)
  const selectedViewTab=useRef<HTMLButtonElement|null>(null)
  const focusedViewTab=useRef<{element:HTMLButtonElement;appId:string;api:HarnessApi}|null>(null)
  const [focusedViewKey,setFocusedViewKey]=useState<string|null>(null)
  useEffect(()=>{if(focusSelectedView){selectedViewTab.current?.focus();setFocusSelectedView(false)}},[focusSelectedView,viewIndex,personal.revision])
  useLayoutEffect(()=>{
    const focused=focusedViewTab.current
    if(!focused||focused.element.isConnected)return
    focusedViewTab.current=null
    setFocusedViewKey(null)
    if(focused.appId===appId&&focused.api===api&&document.activeElement===document.body)selectedViewTab.current?.focus()
  })
  const [section, setSection] = useState<AppSection>(initialSection || 'overview')
  const annotationSection = useRef(section)
  annotationSection.current = section
  useEffect(() => {
    setSection(initialSection || (data ? (data.app.definition.custom?.published ? 'overview' : 'data') : 'overview'))
  }, [initialSection, data?.app.definition.custom?.published])
  const [search, setSearch] = useState('')
  const [searchExpanded,setSearchExpanded]=useState(false)
  const searchInput=useRef<HTMLInputElement>(null)
  const searchToggle=useRef<HTMLButtonElement>(null)
  const searchQuery=useRef<HTMLButtonElement>(null)
  const searchToolbar=useRef<HTMLDivElement>(null)
  const searchFocusRequested=useRef(false)
  const openSearch=()=>{searchFocusRequested.current=true;setSearchExpanded(true)}
  useLayoutEffect(()=>{if(searchExpanded&&searchFocusRequested.current){searchFocusRequested.current=false;searchInput.current?.focus()}},[searchExpanded])
  // A floating toolbar can grow without a window resize. When its compact
  // controls disappear, keep focus in search only if it was on one of them.
  useEffect(()=>{
    const toolbar=searchToolbar.current
    if(!floating||section!=='data'||!toolbar||typeof ResizeObserver==='undefined')return
    let width=0,frame:number|null=null
    const observer=new ResizeObserver(entries=>{
      width=entries[0]?.contentRect.width??0
      if(width<=640||frame!==null||typeof requestAnimationFrame==='undefined')return
      if(document.activeElement!==searchToggle.current&&document.activeElement!==searchQuery.current)return
      // Do not change layout inside ResizeObserver's delivery cycle.
      frame=requestAnimationFrame(()=>{
        frame=null
        if(width>640&&toolbar.clientWidth>640&&(document.activeElement===searchToggle.current||document.activeElement===searchQuery.current))searchInput.current?.focus()
      })
    })
    observer.observe(toolbar)
    return()=>{observer.disconnect();if(frame!==null)cancelAnimationFrame(frame)}
  },[floating,section,Boolean(data)])
  const [creating,setCreating]=useState(false),[fullscreen,setFullscreen]=useState(false)
  const customizeIntent=useRef(0)
  useEffect(()=>()=>{customizeIntent.current++},[api,appId])
  const [chatOpen,setChatOpen]=useState(false)
  const [annotationActive,setAnnotationActive]=useState(false)
  const [annotationSelection,setAnnotationSelection]=useState<AppAnnotationSelection|null>(null)
  const [annotationListOpen,setAnnotationListOpen]=useState(false),[openAnnotationId,setOpenAnnotationId]=useState<string|null>(null)
  const [annotationDraft,setAnnotationDraft]=useState<{id:string;text:string;marker:AppAnnotationMeta}|null>(null)
  const [annotations,setAnnotations]=useState<AppAnnotation[]>([])
  const coveredMain=floating&&chatOpen&&((floatingCompact&&!fullscreen)||(typeof innerWidth==='number'&&innerWidth<720))
  const mainRoot=useRef<HTMLDivElement|null>(null)
  const mainInteraction=useCallback((node:HTMLDivElement|null)=>{mainRoot.current=node;node?.toggleAttribute('inert',coveredMain)},[coveredMain])
  const consumedDraft=useRef<string|undefined>(undefined)
  const consumeDraft=()=>{
    if(!initialDraft)return
    consumedDraft.current=initialDraft
    const next=consumeAppDraftHash(location.hash,appId,orgId,initialDraft)
    if(next){history.replaceState(history.state,'',next);window.dispatchEvent(new HashChangeEvent('hashchange'))}
  }
  const [chatScope,setChatScope]=useState<{tableId?:string;rowId?:string}>({})
  const [editingRecord,setEditingRecord]=useState<Row|null>(null)
  const [deletingRecord,setDeletingRecord]=useState<{api:HarnessApi;appId:string;tableId:string;id:string;updatedAt:string;label:string}|null>(null)
  const [uncertainDeletes,setUncertainDeletes]=useState<Array<{tableId:string;id:string;reason:string}>>([])
  const uncertainDeletesRef=useRef(uncertainDeletes)
  const changeUncertainDeletes=useCallback((update:(items:typeof uncertainDeletes)=>typeof uncertainDeletes)=>{const next=update(uncertainDeletesRef.current);uncertainDeletesRef.current=next;setUncertainDeletes(next)},[])
  useEffect(()=>{changeUncertainDeletes(()=>[])},[api,appId,changeUncertainDeletes])
  const [recordMembers,setRecordMembers]=useState<Array<{ref:string;name:string}>>([]),[recordMembersReady,setRecordMembersReady]=useState(false)
  useEffect(()=>{if(!data?.table.columns.some(c=>c.type==='person')||!creating&&!editingRecord){setRecordMembers([]);setRecordMembersReady(false);return}let active=true;setRecordMembers([]);setRecordMembersReady(false);void api.members().then(result=>{if(active){setRecordMembers(result.members);setRecordMembersReady(true)}},()=>{if(active){setRecordMembers([]);setRecordMembersReady(true)}});return()=>{active=false}},[creating,editingRecord,api,data?.table.columns])
  useEffect(()=>{if(!fullscreen)return;const exit=(e:KeyboardEvent)=>{if(e.key==='Escape'&&!composing(e)&&!creating&&!editingRecord){e.stopPropagation();setFullscreen(false)}};document.addEventListener('keydown',exit);return()=>document.removeEventListener('keydown',exit)},[fullscreen,creating,editingRecord])
  useEffect(()=>{setAnnotationActive(false);setAnnotationSelection(null);setAnnotationListOpen(false)},[section])
  useEffect(()=>{
    let active=true
    const refreshAnnotations=()=>{void api.conversation(appId).then(result=>{if(active)setAnnotations(result.annotations||[])},()=>{if(active)setAnnotations([])})}
    refreshAnnotations()
    const interval=setInterval(()=>{if(document.visibilityState==='visible')refreshAnnotations()},15000)
    return()=>{active=false;clearInterval(interval)}
  },[api,appId])
  const syncAnnotations=useCallback((next:AppAnnotation[])=>setAnnotations(next.filter(annotation=>!annotation.tableId&&!annotation.rowId)),[])
  const [newColumn, setNewColumn] = useState('')
  const [newColumnType, setNewColumnType] = useState<Column['type']>('text')
  const [versions, setVersions] = useState<Array<{ version: number; note: string | null; createdAt: string }> | null>(null)
  const [room, setRoom] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const { busy, error, act } = useAct()
  const pendingCellWrites=useRef(0)
  const pendingPersonalSaves=useRef(0)
  const deferAutomaticCommit=useRef<()=>boolean>(()=>false)
  const markAutomaticPending=useRef<()=>void>(()=>{})

  const load = useCallback((automatic=false,clearUncertain=false) => {
   const observed=clearUncertain?new Set(uncertainDeletesRef.current):null
   return act('load', async () => {
    const sequence=++loadSequence.current
    const readPair=async()=>{
      try{return await Promise.all([api.app(appId),api.personalViews(appId)])}
      catch(e){
        if(e instanceof HarnessApiError&&e.status===404&&sequence===loadSequence.current){
          setData(null);setRelationEntities([]);setPersonal({revision:0,views:[],computed:[],layouts:{}});personalSnapshot.current=null
        }
        throw e
      }
    }
    let [next,preferences]=await readPair()
    if(preferences.snapshot)next=preferences.snapshot
    // If a save won while this read was in flight, its settings are newer but
    // its computed rows may be older than this refresh. Re-read the server's
    // computed views; never splice an old computed snapshot into fresh data.
    for(let attempt=0;attempt<3;attempt++){
      if(sequence!==loadSequence.current)return
      const snapshot=personalSnapshot.current
      const stale=Boolean(snapshot && snapshot.api===api && snapshot.appId===appId && snapshot.value.revision>preferences.revision)
      const versionMismatch=preferences.appVersion!==undefined&&preferences.appVersion!==next.app.version
      if(!stale&&!versionMismatch)break
      ;[next,preferences]=await readPair()
      if(preferences.snapshot)next=preferences.snapshot
    }
    const latest=personalSnapshot.current
    if(latest?.api===api&&latest.appId===appId&&latest.value.revision>preferences.revision)throw new Error('個人ビューが更新中です。再読み込みしてください。')
    if(preferences.appVersion!==undefined&&preferences.appVersion!==next.app.version)throw new Error('アプリが更新中です。再読み込みしてください。')
    const targetKeys=new Set(next.table.columns.filter(column=>column.type==='relation'&&column.targetEntity).map(column=>column.targetEntity!))
    const database=targetKeys.size?await api.appDatabase(appId).catch(()=>null):null
    const targets=await Promise.all((database?.entities||[]).filter(entity=>targetKeys.has(entity.key)).map(async entity=>{
      if(entity.key==='primary')return {...entity,rows:next.rows}
      try{return {...entity,rows:(await api.entityRows(entity.table.id)).rows}}catch{return {...entity,rows:[]}}
    }))
    if(sequence!==loadSequence.current)return
    // The refresh above may have taken time for relation data as well.
    const snapshot=personalSnapshot.current
    if(snapshot?.api===api&&snapshot.appId===appId&&snapshot.value.revision>preferences.revision)throw new Error('個人ビューが更新中です。再読み込みしてください。')
    if(automatic&&deferAutomaticCommit.current()){markAutomaticPending.current();return}
    personalSnapshot.current={api,appId,value:preferences}
    if(observed)changeUncertainDeletes(items=>items.filter(item=>!observed.has(item)))
    setLoadedApi(api);setData(next);setSnapshotPending(false);setRelationEntities(targets);setPersonal(preferences); setViewIndex(Math.max(0,[...next.views,...preferences.computed].findIndex(v=>v.id===preferences.activeView))); if (!initializedSection.current) { initializedSection.current = true; setSection(initialSection || (next.app.definition.custom?.published ? 'overview' : 'data')) }
   })
  }, [api, appId, act, initialSection,changeUncertainDeletes])
  useEffect(() => { setEditingRecord(null);setDeletingRecord(null);setCreating(false);setChatScope(initialConversation||{});setChatOpen(Boolean(initialConversation)||Boolean(openConversation));load();return()=>{loadSequence.current++;initializedSection.current=false} }, [load,initialConversation,openConversation])
  const interaction=useRef({busy,creating,editingRecord,annotationSelection})
  const retryRefresh=useRef<()=>void>(()=>{})
  interaction.current={busy,creating,editingRecord,annotationSelection}
  useEffect(()=>{
    if(typeof window==='undefined'||typeof document==='undefined')return
    let pending=false,running=false,live=true
    const deferred=(ignoreOwnLoad=false)=>{
      const state=interaction.current,root=mainRoot.current,active=document.activeElement
      return Boolean(pendingCellWrites.current || pendingPersonalSaves.current || (state.busy && !(ignoreOwnLoad&&state.busy==='load')) || state.creating || state.editingRecord || state.annotationSelection || root?.querySelector('[role="dialog"]') || document.querySelector?.('[role="dialog"][aria-modal="true"], dialog[open]') ||
        (active && root?.contains(active) && (active.matches?.('input,textarea,select,[contenteditable="true"]') || (active as HTMLElement).isContentEditable)))
    }
    const refresh=()=>{
      if(!live||document.visibilityState==='hidden'||running)return
      if(deferred()){pending=true;return}
      pending=false;running=true
      void load(true).finally(()=>{running=false;if(live&&pending&&!deferred())refresh()})
    }
    const personalViewsChanged=(event:Event)=>{
      const detail=(event as CustomEvent<{orgId?:unknown;appId?:unknown;revision?:unknown}>).detail
      if(detail?.orgId!==orgId||detail?.appId!==appId||!Number.isSafeInteger(detail.revision))return
      const snapshot=personalSnapshot.current
      if(snapshot?.api===api&&snapshot.appId===appId&&Number(detail.revision)<=snapshot.value.revision)return
      refresh()
    }
    const retry=()=>{if(pending)queueMicrotask(refresh)}
    retryRefresh.current=retry
    deferAutomaticCommit.current=()=>deferred(true);markAutomaticPending.current=()=>{pending=true}
    window.addEventListener('focus',refresh);window.addEventListener('online',refresh)
    window.addEventListener('honmaru:personal-views-changed',personalViewsChanged)
    document.addEventListener('visibilitychange',refresh);document.addEventListener('focusout',retry);document.addEventListener('click',retry)
    return()=>{live=false;retryRefresh.current=()=>{};deferAutomaticCommit.current=()=>false;markAutomaticPending.current=()=>{};window.removeEventListener('focus',refresh);window.removeEventListener('online',refresh);window.removeEventListener('honmaru:personal-views-changed',personalViewsChanged);document.removeEventListener('visibilitychange',refresh);document.removeEventListener('focusout',retry);document.removeEventListener('click',retry)}
  },[load,api,appId,orgId])
  useEffect(()=>{retryRefresh.current()},[busy,creating,editingRecord,annotationSelection])

  const selectSection=(next:AppSection)=>{annotationSection.current=next;setSection(next);onSectionChange?.(next);const hash=appSectionHash(location.hash,appId,orgId,next);if(!floating&&hash&&hash!==location.hash)location.hash=hash}
  const customizeApp=async()=>{
    const intent=++customizeIntent.current,previousHash=location.hash
    const sourceHash=await appCustomizeSourceHash(api,appId,orgId)
    if(intent!==customizeIntent.current||location.hash!==previousHash)return
    if(sourceHash){location.hash=sourceHash;return}
    selectSection('custom')
  }
  if (!data || snapshotPending || loadedApi!==api || (personal.appVersion!==undefined&&personal.appVersion!==data.app.version)) return <Shell title={t('Apps')} onClose={onBack} nested>{error ? <div className="form-error">{error}<button className="pill-btn quiet" onClick={()=>void load()}>{t('Retry')}</button></div> : <div className="empty">{t('Loading…')}</div>}</Shell>
  const { app, table } = data
  const allViews = [...data.views,...personal.computed]
  const sharedIds=new Set(data.views.map(v=>v.id))
  const proposedIndex=Math.max(0,Math.min(viewIndex,allViews.length-1))
  const selectedIndex=proposedIndex>=data.views.length && sharedIds.has(allViews[proposedIndex].id)?0:proposedIndex
  const view = allViews[selectedIndex]
  const focusableViewKey=focusedViewKey!==null&&allViews.some((v,i)=>`${i}:${v.id}`===focusedViewKey&&!(i>=data.views.length&&sharedIds.has(v.id)))?focusedViewKey:`${selectedIndex}:${view.id}`
  const isPersonalView=selectedIndex>=data.views.length
  const savePersonal = async (next:PersonalViews) => {pendingPersonalSaves.current++;try{const saved=await api.savePersonalViews(appId,next);if(currentApi.current!==api||currentAppId.current!==appId)return;const latest=personalSnapshot.current;if(latest?.api===api&&latest.appId===appId&&latest.value.revision>=saved.revision)return;personalSnapshot.current={api,appId,value:saved};if(saved.snapshot){setSnapshotPending(true);await load();return}setPersonal(saved);if(saved.appVersion!==undefined&&saved.appVersion!==data.app.version){await load();return}setViewIndex(Math.max(0,[...data.views,...saved.computed].findIndex(v=>v.id===saved.activeView)))}finally{pendingPersonalSaves.current--;retryRefresh.current()}}
  const canEditView=isPersonalView || data.canCustomize !== false
  const saveView = async (patch:Partial<View>) => { if(isPersonalView) { await savePersonal({...personal,views:personal.views.map(v=>v.id===view.id?{...v,...patch}:v)}); return } await api.updateApp(app.id, { expectedVersion: app.version, definition: { ...app.definition, views: app.definition.views.map(v => v.id === view.id ? {...v,...patch} : v) }, note: 'ビューのフィルター・並べ替え・グループを更新' }); await load() }
  const adjustView = (kind:'filter'|'group') => {
    const scope=isPersonalView?'個人ビュー':'ビュー'
    const privateViewNote=isPersonalView?'（この個人ビューだけを変更し、共有ビューは変更しない）':''
    const draft=`「${app.name}」（${table.name}）のデータビューアーの${scope}「${view.name}」の${kind==='filter'?'フィルター':'グループ化'}を調整${privateViewNote}：`
    location.hash=hashForAppSource(app.id,orgId,'data',draft.slice(0,1000))
  }
  const recordLabel=newAppRecordLabel(app.name,table.name,table.columns[0]?.name)
  const localizedRecordLabel=recordLabel==='新規レコード'?t('New record'):t('New {name}').replace('{name}',()=>recordLabel.slice(2))
  const searchLabel=search?`${t('Search records')}: ${search}`:t('Search records')
  const layout = displayLayout(table.columns,personal.layouts[view.id])
  const orderedColumns = [...(layout?.order || []),...layout.columns.map(c=>c.id)].filter((id,i,ids)=>ids.indexOf(id)===i).map(id=>layout.columns.find(c=>c.id===id)).filter((c):c is Column=>!!c)
  const displayColumns = orderedColumns.filter(c=>c.id===table.columns[0]?.id || !layout?.hidden?.includes(c.id))
  const tableSizing=fitTableColumns(displayColumns,layout.widths,tableAvailableWidth)
  const displayCellText=(column:Column,value:unknown)=>{
    if(column.type!=='relation')return cellText(column,value)
    const entity=relationEntities.find(item=>item.key===column.targetEntity)
    const label=(id:string)=>{const row=entity?.rows.find(item=>item.id===id);return row&&entity?relationOptionLabel(entity,row):id}
    return (Array.isArray(value)?value:value==null?[]:[value]).map(id=>label(String(id))).join(', ')
  }
  // A view's server-side filters are already reflected in its rows/lanes/days.
  // Search those results in every record-based presentation, using the same
  // displayed labels (including relation labels) as the table view.
  // Share the formatter within this render rather than constructing one per
  // record; a later render still picks up a changed system time zone.
  const searchDateFormatter=search?systemDateFormatter():undefined
  const matchesSearch = (row: Row) => {
    if(!search)return true
    const query=search.toLowerCase()
    if(table.columns.some(c=>displayCellText(c,row.values[c.id]).toLowerCase().includes(query)))return true
    if([row.id,row.createdAt,row.updatedAt].some(value=>typeof value==='string'&&value!==''&&value.toLowerCase().includes(query)))return true
    return ['$row.createdAt','$row.updatedAt'].some(id=>{
      const text=systemCellText(row,id,searchDateFormatter)
      return text!=='—'&&text.toLowerCase().includes(query)
    })
  }
  const shownRows = (view.rows || []).filter(matchesSearch)
  const exportRows = view.type==='table'&&view.groupBy ? (view.lanes||[]).flatMap(lane=>lane.rows.filter(matchesSearch)) : shownRows
  const exportCurrentView = (format:'csv'|'xlsx') => {
    const safeName=`${app.name}-${view.name}`.replace(/[\\/:*?"<>|\u0000-\u001f]/g,'-').slice(0,120)||'records'
    const formatCell=(column: {id:string;name:string},_value:unknown,row: Row)=>{
      const source=table.columns.find(item=>item.id===column.id)
      return source?displayCellText(source,row.values[source.id]):''
    }
    if(format==='csv') downloadCsv(safeName,csvText(displayColumns,exportRows,formatCell))
    else downloadXlsx(safeName,serializeRowsToXlsx(displayColumns,exportRows,formatCell))
  }
  const shownLanes = (view.lanes || []).map(lane => ({...lane, rows: lane.rows.filter(matchesSearch)}))
  const shownDays = (view.days || []).map(day => ({...day, rows: day.rows.filter(matchesSearch)}))
  const shownUndated = (view.undated || []).filter(matchesSearch)
  const shownCount = view.type === 'table' ? shownRows.length : view.type === 'board' ? shownLanes.reduce((n,lane)=>n+lane.rows.length,0)
    : view.type === 'calendar' ? shownDays.reduce((n,day)=>n+day.rows.length,shownUndated.length) : data.rows.length

  const save = async (row: Row, column: Column, value: unknown) => {
    pendingCellWrites.current++
    try { await act(`cell:${row.id}`, async () => {
      await api.updateRow(table.id, row.id, { [column.id]: value }, row.updatedAt)
      await load()
    }) } finally { pendingCellWrites.current--;retryRefresh.current() }
  }
  const addRow = () => setCreating(true)

  return (
    <Shell
      className={`hx-resource-screen hx-app-detail${chatOpen?' hx-app-with-chat':''}${fullscreen?' hx-app-fullscreen':''}`}
      title={<span className="hx-app-title"><HarnessAppIcon icon={app.icon} size={16} /><button onClick={() => selectSection(app.definition.custom?.published ? 'overview' : 'data')}>{app.name}</button>{section !== 'overview' && <span className="hx-app-breadcrumb">/ {t(section === 'data' ? 'Data viewer' : section === 'custom' ? 'Customize app' : section === 'backend' ? '実行基盤' : 'Settings')}</span>}<button className="hx-app-icon-button" aria-label="データを更新" disabled={busy!==null} onClick={()=>void load(false,true)}><Icon name="refresh" size={14}/></button></span>}
      onClose={onBack}
      nested
      actions={<><button className="pill-btn quiet" onClick={() => void customizeApp()}><Icon name="grid" size={14} />{t('Customize app')}</button><button className="pill-btn quiet" onClick={() => selectSection('settings')}><Icon name="share" size={14} />{t('Sharing')}</button><AppConversationInbox api={api} appId={app.id} onOpen={scope=>{setChatScope(scope);setChatOpen(true)}}/>{(section==='data'||section==='overview'&&Boolean(app.definition.custom?.published))&&<button className="hx-app-icon-button" aria-label={annotationActive?'注釈モードを終了':'注釈'} aria-pressed={annotationActive} title={annotationActive?'注釈モードを終了':'注釈'} onClick={()=>{setAnnotationSelection(null);setAnnotationActive(value=>!value)}}><Icon name="annotate" size={16}/></button>}<button className="hx-app-icon-button" aria-label={chatOpen?'アプリチャットを閉じる':'アプリチャットを開く'} aria-pressed={chatOpen} onClick={()=>{setChatScope({});setChatOpen(!chatOpen)}}><Icon name="message" size={16}/></button><button className="hx-app-icon-button" aria-label={fullscreen?'全画面表示を終了':'全画面表示'} aria-pressed={fullscreen} onClick={()=>setFullscreen(!fullscreen)}><Icon name={fullscreen?'minimize':'maximize'} size={16}/></button><HarnessAppMenu api={api} appId={app.id} orgId={orgId} onSection={selectSection} onFloat={!floating&&floatApp&&['overview','data'].includes(section)?()=>{floatApp(app.id,section);onClose()}:undefined} /><button className="hx-app-icon-button" aria-label={floating?'フローティングアプリを閉じる':'パネルを閉じる'} onClick={onClose}><Icon name="x" size={16}/></button></>}
    >
      {chatOpen&&<AppConversationPanel key={`${orgId}:${app.id}:${chatScope.rowId||"app"}`} api={api} appId={app.id} {...chatScope} title={chatScope.rowId?"レコードチャット":app.name} initialDraft={chatScope.rowId||consumedDraft.current===initialDraft?undefined:initialDraft} onInitialDraftConsumed={consumeDraft} annotationDraft={annotationDraft} onAnnotationDraftConsumed={id=>setAnnotationDraft(current=>current?.id===id?null:current)} onAnnotationsChange={syncAnnotations} context={chatScope.rowId?(displayCellText(table.columns[0],data.rows.find(r=>r.id===chatScope.rowId)?.values[table.columns[0].id])||'選択したレコード'):section==='data'?`現在のデータ表示: ${view.name}`:undefined} onClose={()=>setChatOpen(false)}/>}
      <div ref={mainInteraction} className="hx-app-main">
      {annotationActive&&<AppAnnotationLayer key={`${appId}:${section}`} tableId={section==='data'?table.id:undefined} columns={section==='data'?displayColumns:[]} showAnnotations={annotationListOpen} onShowAnnotations={()=>setAnnotationListOpen(value=>!value)} onCancel={()=>{setAnnotationActive(false);setAnnotationListOpen(false)}} onSelect={selection=>{if(annotationSection.current!==section||currentAppId.current!==appId||currentApi.current!==api)return;setAnnotationSelection(selection);setAnnotationActive(false)}}/>}
      {(section==='overview'||section==='data')&&<AppAnnotationMarkers annotations={annotations} section={section} openId={openAnnotationId} onOpenChange={setOpenAnnotationId}/>}
      {annotationListOpen&&(section==='overview'||section==='data')&&<AppAnnotationList annotations={annotations} onClose={()=>setAnnotationListOpen(false)} onSelect={annotation=>{setAnnotationListOpen(false);setOpenAnnotationId(annotation.id);if(annotation.section!==section)selectSection(annotation.section)}}/>}
      {annotationSelection&&<AppAnnotationDialog selection={annotationSelection} appName={app.name} section={section==='data'?'データビューアー':'アプリ画面'} context={section==='data'?`${table.name} · ${view.name}`:app.name} onCancel={()=>setAnnotationSelection(null)} onSubmit={comment=>{const marker:AppAnnotationMeta={target:annotationSelection.target,x:annotationSelection.x,y:annotationSelection.y,section:section==='data'?'data':'overview'};const column=table.columns.find(item=>item.id===annotationSelection.columnId);const targetField=column?`\n選択フィールド: ${column.name} (${column.id})`:'';const annotation={id:crypto.randomUUID(),marker,text:`注釈: ${app.name} · ${section==='data'?'データビューアー':'アプリ画面'} · ${annotationSelection.target} · 画面位置 ${annotationSelection.x}% / ${annotationSelection.y}%${targetField}\n${comment}`};setAnnotationDraft(annotation);setChatScope(annotationSelection.tableId&&annotationSelection.rowId?{tableId:annotationSelection.tableId,rowId:annotationSelection.rowId}:{});setChatOpen(true);setAnnotationSelection(null)}}/>}
      {section !== 'overview' && section !== 'data' && <nav className="hx-app-sections" aria-label={t('App sections')}>{(['overview', 'data', 'custom', 'backend', 'settings'] as const).map(tab => <button key={tab} aria-current={section === tab ? 'page' : undefined} className={section === tab ? 'on' : ''} onClick={() => selectSection(tab)}>{t(tab === 'overview' ? 'Overview' : tab === 'data' ? 'Data viewer' : tab === 'custom' ? 'Customize app' : tab === 'backend' ? '実行基盤' : 'Settings')}</button>)}</nav>}
      {creating&&<AppRecordDialog appName={app.name} tableName={table.name} createTitle={localizedRecordLabel} columns={table.columns} relationEntities={relationEntities} members={recordMembers} membersReady={recordMembersReady} save={async values=>{await api.addRow(table.id,values,'strict');await load()}} onClose={()=>setCreating(false)}/>}
      {editingRecord&&<AppRecordDialog key={editingRecord.id} appName={app.name} columns={table.columns} relationEntities={relationEntities} members={recordMembers} membersReady={recordMembersReady} record={editingRecord} conversation={<AppConversationPanel key={`${orgId}:${app.id}:${editingRecord.id}`} api={api} appId={app.id} tableId={table.id} rowId={editingRecord.id} title="レコードチャット" context={displayCellText(table.columns[0],editingRecord.values[table.columns[0].id])||editingRecord.id}/>} save={async values=>{if(Object.keys(values).length)await api.updateRow(table.id,editingRecord.id,values,editingRecord.updatedAt);await load()}} onClose={()=>setEditingRecord(null)}/>}
      {deletingRecord?.api===api&&deletingRecord.appId===appId&&<AppRowDeleteConfirm key={`${deletingRecord.tableId}:${deletingRecord.id}:${deletingRecord.updatedAt}`} label={deletingRecord.label} rowId={deletingRecord.id} uncertain={uncertainDeletes.some(item=>item.tableId===deletingRecord.tableId&&item.id===deletingRecord.id)} initialReason={uncertainDeletes.find(item=>item.tableId===deletingRecord.tableId&&item.id===deletingRecord.id)?.reason} onUncertain={reason=>{if(currentApi.current!==deletingRecord.api||currentAppId.current!==deletingRecord.appId)return;changeUncertainDeletes(items=>items.some(item=>item.tableId===deletingRecord.tableId&&item.id===deletingRecord.id)?items:[...items,{tableId:deletingRecord.tableId,id:deletingRecord.id,reason}])}} onClose={()=>setDeletingRecord(null)} onDelete={async()=>{const result=await deletingRecord.api.deleteRow(deletingRecord.tableId,deletingRecord.id,deletingRecord.updatedAt);if(!result.deleted)throw new Error('Delete was not confirmed.')}} onDeleted={()=>{if(currentApi.current!==deletingRecord.api||currentAppId.current!==deletingRecord.appId)return;setDeletingRecord(null);void load()}}/>}
      {section === 'backend' && <CompanyApp app={app} api={api} canManage={data.canCustomize !== false} reload={load} />}
      {section === 'custom' && data.canCustomize === false && <p>カスタムコードの編集・公開は、作成者または管理者が行えます。</p>}
      {section === 'custom' && data.canCustomize !== false && <CustomAppEditor httpBase={httpBase} app={app} table={table} rows={data.rows} api={api} reload={load} />}
      {section === 'overview' && app.definition.custom?.published && <AppViewportPreview><CustomAppFrame appId={app.id} api={api} reload={load} httpBase={httpBase} html={app.definition.custom.published} table={table} rows={data.rows} /></AppViewportPreview>}
      {section === 'overview' && !app.definition.custom?.published && <AppViewportPreview><DatabaseAppPreview app={app} table={table} rows={data.rows} renderCell={(column,row)=>isSystemColumn(column.id)?systemCellText(row,column.id):displayCellText(column,row.values[column.id])} onBrowseData={()=>selectSection('data')} /></AppViewportPreview>}
      {section === 'data' && <>
      <div className="hx-data-toolbar" ref={searchToolbar}><div className="hx-data-heading"><h2>{appTableDisplayName(app.name,table.name,table.columns[0]?.name)}</h2><button className="pill-btn hx-create-record" title={localizedRecordLabel} aria-label={localizedRecordLabel} onClick={addRow} disabled={busy !== null}><Icon name="plus" size={14} />{localizedRecordLabel}</button></div>
      <div className="hx-tabs">
        <div className="hx-view-tabs" role="tablist" aria-label={t('Views')}>
        {allViews.map((v, i) => (
          <button key={`${i}:${v.id}`} ref={i===selectedIndex?selectedViewTab:undefined} role="tab" aria-selected={i === selectedIndex} tabIndex={`${i}:${v.id}`===focusableViewKey?0:-1} className={i === selectedIndex ? 'on' : ''} disabled={i>=data.views.length&&sharedIds.has(v.id)} title={i>=data.views.length&&sharedIds.has(v.id)?'共有ビューとIDが重複しているため利用できません。':undefined} onFocus={e=>{focusedViewTab.current={element:e.currentTarget,appId,api};setFocusedViewKey(`${i}:${v.id}`)}} onBlur={e=>{if(focusedViewTab.current?.element===e.currentTarget)focusedViewTab.current=null;if(!e.currentTarget.parentElement?.contains(e.relatedTarget))setFocusedViewKey(null)}} onKeyDown={e=>{
            if(e.defaultPrevented||e.altKey||e.ctrlKey||e.metaKey||e.shiftKey||composing(e)||!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return
            const tabs=Array.from(e.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(':scope > [role="tab"]:not(:disabled)')||[])
            const current=tabs.indexOf(e.currentTarget)
            if(current<0||!tabs.length)return
            e.preventDefault()
            const next=e.key==='Home'?0:e.key==='End'?tabs.length-1:(current+(e.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length
            tabs[next]?.focus()
          }} onClick={() => {setViewIndex(i);void act('view',()=>savePersonal({...personal,activeView:v.id}))}}>
            <Icon name={v.type === 'board' ? 'grid' : v.type === 'metrics' ? 'insights' : v.type === 'calendar' ? 'calendar' : 'list'} size={14} /> {v.name}{i>=data.views.length && <small className="hx-personal-badge">個人</small>}
          </button>
        ))}
        </div>
        <PersonalViewControls sharedIds={[...sharedIds]} control="view" key={`new:${selectedIndex}:${view.id}:${personal.revision}`} view={view} personal={isPersonalView} columns={table.columns} state={personal} save={savePersonal} onSelect={()=>{}} onRemoved={()=>{if(!personalSnapshot.current?.value.views.some(v=>v.id===view.id))setFocusSelectedView(true)}} onSettings={()=>selectSection('settings')} />
      </div>
      <div className={`hx-data-tools${searchExpanded&&view.type!=='metrics'?' hx-search-expanded':''}`}>{view.type!=='metrics'&&<><button ref={searchToggle} className="hx-floating-search pill-btn quiet" title={searchLabel} aria-label={searchLabel} aria-expanded={searchExpanded} onClick={()=>{if(searchExpanded)setSearchExpanded(false);else openSearch()}}><Icon name="search" size={14}/></button><input ref={searchInput} className="hx-cell-input" type="search" aria-label={t('Search records')} placeholder={t('Search records')} value={search} onFocus={()=>setSearchExpanded(true)} onChange={e => setSearch(e.target.value)} />{search&&!searchExpanded&&<button ref={searchQuery} type="button" className="hx-floating-search-query" title={`${t('Search')}: ${search}`} onClick={openSearch}>{t('Search')}: {search}</button>}</>}<PersonalViewControls control="fields" key={`${selectedIndex}:${view.id}:${personal.revision}`} view={view} personal={isPersonalView} columns={table.columns} state={personal} save={savePersonal} onSelect={()=>{}} onSettings={()=>selectSection('settings')} /><AppViewControls key={`${selectedIndex}:${view.id}:${app.version}:${personal.revision}`} view={view} columns={table.columns} relationEntities={relationEntities} personal={isPersonalView} onAdjust={adjustView} canEdit={canEditView} save={saveView} />{view.type==='table'&&<AppDataMenu wrapText={layout.wrapText===true} save={wrapText=>savePersonal({...personal,layouts:{...personal.layouts,[view.id]:{order:layout.order,widths:layout.widths,hidden:layout.hidden,wrapText}}})} onExport={exportCurrentView}/>}{shouldShowRecordCount(shownCount,search,(view.filters?.length || 0)+Object.keys(view.where || {}).length)&&<span className="hx-record-count">{t('{n} records', { n: shownCount })}</span>}</div>
      </div>
      {error && <div className="form-error">{error}</div>}
      {data.canCustomize !== false && app.definition.views.length < 12 && !data.views.some(v => v.type === 'calendar') && table.columns.some(c => c.type === 'date' || c.type === 'datetime') && <button className="pill-btn quiet" disabled={busy !== null} onClick={() => act('calendar', async () => {
        const dateColumn = table.columns.find(c => c.type === 'datetime') || table.columns.find(c => c.type === 'date')!
        await api.updateApp(app.id, { definition: { ...app.definition, views: [...app.definition.views, { type: 'calendar', name: t('Calendar'), dateColumn: dateColumn.id, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' }] } })
        await load()
      })}>{t('Add calendar view')}</button>}

      {view.type === 'calendar' && <AppCalendar key={`${view.id}:${view.timeZone||'UTC'}`} view={{...view,days:shownDays,undated:shownUndated}} table={table} displayCellText={displayCellText} onOpen={setEditingRecord} onMove={(row, date) => { const column = table.columns.find(c => c.id === view.dateColumn); if (column) void save(row, column, date) }} />}

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
          {shownLanes.map((lane) => (
            <div className="hx-lane" key={lane.key ?? '—'}>
              <div className="hx-lane-head">{lane.key ?? t('No value')} <span className="hx-count">{lane.rows.length}</span></div>
              {lane.rows.map((row) => {
                const groupCol = table.columns.find((c) => c.id === view.groupBy)
                const title = table.columns[0]
                return (
                  <div className="hx-card" key={row.id}>
                    <button className="hx-card-title hx-record-title" onClick={()=>setEditingRecord(row)} aria-label={`${title ? displayCellText(title,row.values[title.id]) || '無題' : row.id}の詳細を開く`}>{title ? displayCellText(title, row.values[title.id]) || '—' : row.id}<Icon name="maximize" size={13}/></button>
                    {table.columns.slice(1, 4).filter((c) => c.id !== view.groupBy && row.values[c.id] != null).map((c) => (
                      <div className="hx-card-field" key={c.id}><span>{c.name}</span> {displayCellText(c, row.values[c.id])}</div>
                    ))}
                    {groupCol && <AppDataCell column={groupCol} value={row.values[groupCol.id]} displayValue={displayCellText(groupCol,row.values[groupCol.id])} relationEntities={relationEntities} onSave={v=>save(row,groupCol,v)}/>}
                  </div>
                )
              })}
            </div>
          ))}
        </div>
      )}

      {search && shownCount === 0 && (view.type === 'board' || view.type === 'calendar') && <div className="hx-table-empty" role="status"><strong>レコードがありません</strong><span>この表示に一致するレコードはありません。</span></div>}

      {view.type === 'table' && (
        <div className="hx-table-wrap" ref={tableWrapRef}>
          <table className={`hx-table hx-personal-table${layout.wrapText?' hx-wrap-text':''}`} style={{width:tableSizing.width,minWidth:tableSizing.width}}>
            <colgroup>{displayColumns.map(c=><col key={c.id} style={{width:tableSizing.widths[c.id]}}/>)}</colgroup>
            <thead>
              <tr>{displayColumns.map((c) => <th key={c.id} aria-sort={view.sort===c.id?'ascending':view.sort===`-${c.id}`?'descending':'none'}><button className="hx-column-sort" disabled={!canEditView||busy!==null} aria-label={`${c.name}で${view.sort===c.id?'降順に並べ替え':view.sort===`-${c.id}`?'並べ替えを解除':'昇順に並べ替え'}`} onClick={()=>void act('sort',()=>saveView({sort:nextColumnSort(view.sort,c.id)}))}>{c.name}<Icon name={view.sort===c.id?'arrow-up':view.sort===`-${c.id}`?'arrow-down':'sort'} size={12}/></button><ColumnResize name={c.name} width={tableSizing.widths[c.id]} save={width=>act('layout',()=>savePersonal({...personal,layouts:{...personal.layouts,[view.id]:{...personal.layouts[view.id],hidden:layout.hidden,order:orderedColumns.map(c=>c.id),widths:{...layout?.widths,[c.id]:width}}}}))}/></th>)}</tr>
            </thead>
            <tbody>
              {(view.groupBy ? (view.lanes || []).map(lane=>({...lane,rows:lane.rows.filter(row=>shownRows.some(r=>r.id===row.id))})) : [{key:null,rows:shownRows}]).map((group,groupIndex)=><React.Fragment key={group.key ?? groupIndex}>
              {view.groupBy && <tr className="hx-table-group"><th colSpan={displayColumns.length}>{group.key ?? '未設定'} <span className="hx-count">{group.rows.length}</span></th></tr>}
              {group.rows.map((row) => (
                <tr key={row.id} data-row={row.id}>
                  {displayColumns.map((c,i) => (
                    <td key={c.id}><AppDataCell column={c} value={row.values[c.id]} displayValue={isSystemColumn(c.id)?systemCellText(row,c.id):displayCellText(c,row.values[c.id])} title={isSystemColumn(c.id)?c.id==='$row.id'?row.id:c.id==='$row.createdAt'?row.createdAt:row.updatedAt:undefined} editable={!isSystemColumn(c.id)} relationEntities={relationEntities} members={recordMembers} width={tableSizing.widths[c.id]} wrap={layout.wrapText===true} onSave={v=>save(row,c,v)}/>{i===displayColumns.length-1&&<AppRowActions label={displayCellText(table.columns[0],row.values[table.columns[0].id])||'無題'} actionsLabel={t('Actions')} openLabel={`${displayCellText(table.columns[0],row.values[table.columns[0].id])||'無題'}の詳細を開く`} deleteLabel={t('Delete row')} onOpen={()=>setEditingRecord(row)} onDelete={()=>setDeletingRecord({api,appId,tableId:table.id,id:row.id,updatedAt:row.updatedAt,label:displayCellText(table.columns[0],row.values[table.columns[0].id])||'無題'})} deleteDisabled={busy===`del:${row.id}`}/>}</td>
                  ))}

                </tr>
              ))}</React.Fragment>)}
            </tbody>
          </table>
          {shownRows.length === 0 && <div className="hx-table-empty"><strong>レコードがありません</strong><span>この表示に一致するレコードはありません。</span></div>}
        </div>
      )}
      </>}
      {section === 'settings' && <>
      <h2>{t('Fields')}</h2><div className="rows">{table.columns.map(column => <div className="row static" key={column.id}><span className="row-main">{column.name}</span><span className="row-sub">{column.type}</span></div>)}</div>
      {data.canCustomize !== false && <form className="hx-actions" onSubmit={event => { event.preventDefault(); void act('column', async () => { await api.updateApp(app.id, { columns: [...table.columns, { name: newColumn.trim(), type: newColumnType }] }); setNewColumn(''); await load() }) }}><input className="hx-cell-input" aria-label={t('Field name')} placeholder={t('Field name')} value={newColumn} onChange={e => setNewColumn(e.target.value)} /><select aria-label={t('Field type')} value={newColumnType} onChange={e => setNewColumnType(e.target.value as Column['type'])}>{(['text', 'number', 'date', 'datetime', 'checkbox', 'person', 'email', 'url'] as const).map(type => <option key={type} value={type}>{type}</option>)}</select><button className="pill-btn" disabled={busy !== null || !newColumn.trim()}>{t('Add field')}</button></form>}
      <AppSharing key={`${httpBase}:${orgId}:${appId}:${sessionToken}`} httpBase={httpBase} orgId={orgId} sessionToken={sessionToken} appId={appId} appVersion={data.app.version} />
      <ExternalAppSharing key={`external:${httpBase}:${orgId}:${appId}:${sessionToken}`} httpBase={httpBase} orgId={orgId} sessionToken={sessionToken} appId={appId} />
      <TemplateSharing key={`${orgId}:${appId}:${app.version}`} api={api} appId={app.id} appVersion={app.version} />

      {data.canCustomize !== false && <>
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
      </>}

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
            <span className="row-icon"><Icon name={c.kind === 'workflow' ? 'zap' : c.kind === 'access' ? 'shield' : 'sparkle'} size={18} /></span>
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
