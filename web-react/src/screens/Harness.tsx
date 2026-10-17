import { AppSharing } from '../components/AppSharing'
import { AppCalendar } from '../components/AppCalendar'
import React, { useCallback, useEffect, useState } from 'react'
import { useT } from '../utils/i18n'
import { Icon } from '../components/Icon'
import { hashForCard } from '../utils/route'
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

export const HarnessApps: React.FC<HarnessProps> = (props) => {
  const t = useT()
  const api = useApi(props)
  const [apps, setApps] = useState<App[] | null>(null)
  const [templates, setTemplates] = useState<Template[]>([])
  // An app opened from a room's details (RoomApps) arrives already open.
  const [open, setOpen] = useState<string | null>(() => {
    try { const id = sessionStorage.getItem('hx.openApp'); sessionStorage.removeItem('hx.openApp'); return id } catch { return null }
  })
  const [prompt, setPrompt] = useState('')
  const [creating, setCreating] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const { busy, error, act } = useAct()

  const load = useCallback(() => act('load', async () => {
    const [a, tpl] = await Promise.all([api.apps(), api.templates()])
    setApps(a.apps); setTemplates(tpl.templates)
  }), [api, act])
  useEffect(() => { load() }, [load])

  if (open) return <AppView {...props} api={api} appId={open} onBack={() => { setOpen(null); load() }} />

  const generate = () => act('generate', async () => {
    const room = prompt.match(/#([\p{L}\p{N}_-]+)/u)?.[1]
    const made = await api.generate(prompt, room ? `b:${room}` : undefined)
    setPrompt('')
    setNote(made.source === 'model' ? t('Built from your description.') : t('Started from the closest template. Change its columns any time.'))
    setOpen(made.app.id)
  })
  const fromTemplate = (id: string) => act(`tpl:${id}`, async () => {
    const made = await api.createFromTemplate(id)
    setOpen(made.app.id)
  })

  return (
    <Shell className="hx-resource-screen" title={t('Apps')} onClose={props.onClose} actions={<button className="pill-btn" onClick={() => setCreating(v => !v)}>{t(creating ? 'Cancel' : 'Build an app')}</button>}>
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

      <div className="rows-title">{t('Your apps')}</div>
      {apps === null && <div className="empty">{t('Loading…')}</div>}
      {apps?.length === 0 && !creating && <div className="hx-resource-empty"><span className="hx-resource-symbol"><Icon name="grid" size={24} /></span><h2>{t('No apps yet')}</h2><p>{t('Apps are small tools your agents build for this room: dashboards, trackers and forms.')}</p><button onClick={() => setCreating(true)}>{t('Build an app')}</button></div>}
      {apps && apps.length > 0 && (
        <div className="hx-app-grid">
          {apps.map((a) => (
            <button key={a.id} className="hx-app-tile" onClick={() => setOpen(a.id)} data-app={a.id}>
              <span className="hx-app-icon" aria-hidden="true">{a.icon}</span>
              <span className="hx-app-name">{a.name}</span>
              <span className="hx-app-sub">{a.description}</span>
              {a.channels && a.channels.length > 0 && <span className="hx-app-rooms">{a.channels.map((c) => c.replace(/^b:/, '#')).join(' ')}</span>}
            </button>
          ))}
        </div>
      )}

      {creating && <>
      <div className="rows-title">{t('Templates')}</div>
      <div className="hx-app-grid">
        {templates.map((tpl) => (
          <button key={tpl.id} className="hx-app-tile template" onClick={() => fromTemplate(tpl.id)} disabled={busy === `tpl:${tpl.id}`}>
            <span className="hx-app-icon" aria-hidden="true">{tpl.icon}</span>
            <span className="hx-app-name">{t(tpl.name)}</span>
            <span className="hx-app-sub">{t(tpl.description)}</span>
          </button>
        ))}
      </div>
      </>}
    </Shell>
  )
}

function CellInput({ column, value, onSave }: { column: Column; value: unknown; onSave: (v: unknown) => void }) {
  const [draft, setDraft] = useState<string>(value == null ? '' : String(value))
  useEffect(() => { setDraft(value == null ? '' : String(value)) }, [value])
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

export const AppView: React.FC<HarnessProps & { api: HarnessApi; appId: string; onBack: () => void }> = ({ api, appId, onBack, httpBase, orgId, sessionToken }) => {
  const t = useT()
  const [data, setData] = useState<{ app: App; table: Table; rows: Row[]; views: View[] } | null>(null)
  const [viewIndex, setViewIndex] = useState(0)
  const [section, setSection] = useState<'overview' | 'data' | 'settings'>('overview')
  const [search, setSearch] = useState('')
  const [newColumn, setNewColumn] = useState('')
  const [newColumnType, setNewColumnType] = useState<Column['type']>('text')
  const [versions, setVersions] = useState<Array<{ version: number; note: string | null; createdAt: string }> | null>(null)
  const [room, setRoom] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const { busy, error, act } = useAct()

  const load = useCallback(() => act('load', async () => { setData(await api.app(appId)) }), [api, appId, act])
  useEffect(() => { load() }, [load])

  if (!data) return <Shell title={t('Apps')} onClose={onBack} nested>{error ? <div className="form-error">{error}</div> : <div className="empty">{t('Loading…')}</div>}</Shell>
  const { app, table } = data
  const view = data.views[Math.min(viewIndex, data.views.length - 1)]
  const shownRows = (view.rows || []).filter(row => !search || table.columns.some(c => cellText(c, row.values[c.id]).toLowerCase().includes(search.toLowerCase())))

  const save = (row: Row, column: Column, value: unknown) => act(`cell:${row.id}`, async () => {
    await api.updateRow(table.id, row.id, { [column.id]: value }, row.updatedAt)
    await load()
  })
  const addRow = () => act('add', async () => {
    const first = table.columns[0]
    const seed: Record<string, unknown> = {}
    if (view.type === 'board' && view.groupBy) {
      const col = table.columns.find((c) => c.id === view.groupBy)
      if (col?.options?.[0]) seed[col.id] = col.options[0]
    }
    if (first && first.type === 'text') seed[first.id] = t('New')
    await api.addRow(table.id, seed)
    await load()
  })
  const removeRow = (row: Row) => act(`del:${row.id}`, async () => { await api.deleteRow(table.id, row.id, row.updatedAt); await load() })

  return (
    <Shell
      className="hx-resource-screen hx-app-detail"
      title={`${app.icon} ${app.name}`}
      onClose={onBack}
      nested
      actions={<><button className="pill-btn quiet" onClick={() => setSection('settings')}>{t('Customize app')}</button><button className="pill-btn quiet" onClick={() => setSection('settings')}>{t('Sharing')}</button><button className="pill-btn quiet" disabled={busy !== null} onClick={() => void load()}>{t('Reload')}</button><span className="hx-version">v{app.version}</span></>}
    >
      <nav className="hx-app-sections" aria-label={t('App sections')}>{(['overview', 'data', 'settings'] as const).map(tab => <button key={tab} aria-current={section === tab ? 'page' : undefined} className={section === tab ? 'on' : ''} onClick={() => setSection(tab)}>{t(tab === 'overview' ? 'Overview' : tab === 'data' ? 'Data viewer' : 'Settings')}</button>)}</nav>
      {section === 'overview' && <div className="hx-app-overview"><span className="hx-resource-symbol"><Icon name="grid" size={24} /></span><h2>{t('Database app')}</h2><p>{app.description || t('Browse and manage this app’s data in the data viewer.')}</p><div className="hx-actions"><button className="pill-btn" onClick={() => setSection('data')}>{t('Browse data')}</button><button className="pill-btn quiet" onClick={() => setSection('settings')}>{t('Customize app')}</button></div><small>{t('{n} records', { n: data.rows.length })} · {table.columns.length} {t('Fields')}</small></div>}
      {section === 'data' && <>
      <div className="hx-data-heading"><h2>{app.name}</h2><button className="pill-btn" onClick={addRow} disabled={busy !== null}><Icon name="plus" size={14} />{t('Add a row')}</button></div>
      <div className="hx-data-tools"><input className="hx-cell-input" type="search" aria-label={t('Search records')} placeholder={t('Search records')} value={search} onChange={e => setSearch(e.target.value)} /><button className="pill-btn quiet" onClick={() => setSection('settings')}>{t('Fields')}</button><span>{t('{n} records', { n: data.rows.length })}</span></div>
      <div className="hx-tabs" role="tablist">
        {data.views.map((v, i) => (
          <button key={v.id} role="tab" aria-selected={i === viewIndex} className={i === viewIndex ? 'on' : ''} onClick={() => setViewIndex(i)}>
            <Icon name={v.type === 'board' ? 'grid' : v.type === 'metrics' ? 'insights' : 'list'} size={14} /> {v.name}
          </button>
        ))}
      </div>
      {error && <div className="form-error">{error}</div>}
      {app.definition.views.length < 12 && !data.views.some(v => v.type === 'calendar') && table.columns.some(c => c.type === 'date') && <button className="pill-btn quiet" disabled={busy !== null} onClick={() => act('calendar', async () => {
        await api.updateApp(app.id, { definition: { ...app.definition, views: [...app.definition.views, { type: 'calendar', name: t('Calendar'), dateColumn: table.columns.find(c => c.type === 'date')!.id }] } })
        await load()
      })}>{t('Add calendar view')}</button>}

      {view.type === 'calendar' && <AppCalendar key={view.id} view={view} table={table} onMove={(row, date) => { const column = table.columns.find(c => c.id === view.dateColumn); if (column) void save(row, column, date) }} />}

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
                    <div className="hx-card-title">{title ? cellText(title, row.values[title.id]) || '—' : row.id}</div>
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
          <table className="hx-table">
            <thead>
              <tr>{table.columns.map((c) => <th key={c.id}>{c.name}</th>)}<th aria-label={t('Actions')} /></tr>
            </thead>
            <tbody>
              {shownRows.map((row) => (
                <tr key={row.id} data-row={row.id}>
                  {table.columns.map((c) => (
                    <td key={c.id}><CellInput column={c} value={row.values[c.id]} onSave={(v) => save(row, c, v)} /></td>
                  ))}
                  <td><button className="btn-text danger" onClick={() => removeRow(row)} disabled={busy === `del:${row.id}`} aria-label={t('Delete row')}><Icon name="trash" size={14} /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
          {shownRows.length === 0 && <div className="empty">{t('Nothing here yet.')}</div>}
        </div>
      )}
      {view.type !== 'metrics' && <button className="pill-btn quiet hx-add" onClick={addRow} disabled={busy === 'add'}><Icon name="plus" size={14} /> {t('Add a row')}</button>}

      </>}
      {section === 'settings' && <>
      <h2>{t('Fields')}</h2><div className="rows">{table.columns.map(column => <div className="row static" key={column.id}><span className="row-main">{column.name}</span><span className="row-sub">{column.type}</span></div>)}</div>
      <form className="hx-actions" onSubmit={event => { event.preventDefault(); void act('column', async () => { await api.updateApp(app.id, { columns: [...table.columns, { name: newColumn.trim(), type: newColumnType }] }); setNewColumn(''); await load() }) }}><input className="hx-cell-input" aria-label={t('Field name')} placeholder={t('Field name')} value={newColumn} onChange={e => setNewColumn(e.target.value)} /><select aria-label={t('Field type')} value={newColumnType} onChange={e => setNewColumnType(e.target.value as Column['type'])}>{(['text', 'number', 'date', 'checkbox', 'person', 'email', 'url'] as const).map(type => <option key={type} value={type}>{type}</option>)}</select><button className="pill-btn" disabled={busy !== null || !newColumn.trim()}>{t('Add field')}</button></form>
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
            {v.version !== app.version && <button className="btn-text" onClick={() => act('restore', async () => { await api.restore(app.id, v.version); setVersions(null); await load() })}>{t('Restore')}</button>}
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
