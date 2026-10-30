import { HarnessAppIcon } from './HarnessAppIcon'
import React, { useEffect, useMemo, useState } from 'react'
import { harnessApi, type App, type Workflow } from '../utils/harness'
import { useT } from '../utils/i18n'
import { Icon } from './Icon'

export function HarnessRoomResources({ api, channel, kind, onClose, onCreate, onOpenApp, onOpenWorkflow, onLegacy }: {
  api: { httpBase: string; orgId: string; sessionToken: string }; channel: string; kind: 'apps' | 'workflows';
  onClose: () => void; onCreate: () => void; onOpenApp?: (id?: string) => void; onOpenWorkflow?: (id?: string) => void; onLegacy: () => void
}) {
  const t = useT()
  const client = useMemo(() => harnessApi(api.httpBase, api.orgId, api.sessionToken), [api.httpBase, api.orgId, api.sessionToken])
  const [data, setData] = useState<{ apps: App[]; workflows: Workflow[] } | null>(null)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    let live = true; setData(null); setError('')
    Promise.all([client.apps(channel), kind === 'workflows' ? client.workflows() : Promise.resolve({ workflows: [] })]).then(([a, w]) => {
      if (!live) return
      const appIds = new Set(a.apps.map(app => app.id))
      const tables = new Set(a.apps.map(app => app.tableId))
      setData({ apps: a.apps, workflows: w.workflows.filter(flow => flow.sourceChannel === channel || Boolean(flow.trigger.appId && appIds.has(flow.trigger.appId)) || flow.steps.some(step => (step.channel === channel || step.channel?.startsWith(`${channel}|`))) || Boolean(flow.trigger.tableId && tables.has(flow.trigger.tableId))) })
    }).catch(e => { if (live) setError(e instanceof Error ? e.message : String(e)) })
    return () => { live = false }
  }, [client, channel, kind, retry])
  const apps = kind === 'apps', count = data ? (apps ? data.apps.length : data.workflows.length) : null
  return <aside className="hx-room-resource slk-pane" aria-label={t(apps ? 'Apps' : 'Automations')}>
    <header><strong>{count === null ? t(apps ? 'Apps' : 'Automations') : t(apps ? '{n} apps' : '{n} workflows', { n: count })}</strong><button onClick={onClose} aria-label={t('Close resources')}><Icon name="x" size={16} /></button></header>
    {error ? <div className="hx-resource-empty" role="alert"><p>{error}</p><button onClick={() => setRetry(n => n + 1)}>{t('Retry')}</button></div> : !data ? <p className="hx-resource-loading" role="status">{t('Loading…')}</p> : count === 0 ? <div className="hx-resource-empty"><span className="hx-resource-symbol"><Icon name={apps ? 'grid' : 'zap'} size={18} /></span><h2>{t(apps ? 'No apps in this room yet' : 'No automations in this room yet')}</h2><p>{t(apps ? 'Apps are small tools your agents build for this room: dashboards, trackers and forms.' : 'Automations do work on a schedule or when something happens in this room.')}</p><button onClick={onCreate}>{t(apps ? 'Build an app' : 'Set up an automation')}</button></div> : <div className="hx-resource-items">
      {apps ? data.apps.map(app => <button key={app.id} className="hx-resource-item" onClick={() => onOpenApp?.(app.id)}><span className="hx-resource-symbol"><HarnessAppIcon icon={app.icon} /></span><span><b>{app.name}</b><small>{app.description}</small></span><Icon name="chevron-right" size={14} /></button>) : data.workflows.map(flow => <button key={flow.id} className="hx-resource-item" onClick={() => onOpenWorkflow?.(flow.id)}><span className="hx-resource-symbol"><Icon name="zap" size={18} /></span><span><b>{flow.name}</b><small>{t(flow.enabled ? 'On' : 'off')} · {t(flow.trigger.type)}{flow.nextRunAt ? ` · ${new Date(flow.nextRunAt).toLocaleString()}` : ''}</small></span><Icon name="chevron-right" size={14} /></button>)}
      <button className="hx-resource-create" onClick={onCreate}><Icon name="plus" size={15} />{t(apps ? 'Build an app' : 'Set up an automation')}</button>
    </div>}
    <footer><button onClick={() => apps ? onOpenApp?.() : onOpenWorkflow?.()}>{t(apps ? 'Manage all apps' : 'Manage all workflows')}</button>{!apps && <button onClick={onLegacy}>{t('Room schedules')}</button>}</footer>
  </aside>
}
