import type {App,AppEntity,StepType,Trigger,Table} from './harness'
import {getLocale} from './locale'
export const weekdayName = (day:number) => new Intl.DateTimeFormat(getLocale(),{weekday:'long',timeZone:'UTC'}).format(new Date(Date.UTC(2026,0,4+day)))

export interface WorkflowAppOption {app:Pick<App,'id'|'name'>;entities:AppEntity[]}

export function stepLabel(t: (k: string) => string, type: StepType) {
  return ({
    code: t('TypeScript program'), post: t('Post in a room'), agent: t('Ask an agent'), add_row: t('Add a row'),
    update_row: t('Change the row'), approval: t('Ask for approval'), followup: t('Follow up later'),
  } as Record<StepType, string>)[type]
}

export function triggerLabel(t: (k: string, v?: Record<string, string | number>) => string, tr: Trigger, tables: Table[], apps:WorkflowAppOption[] = []) {
  if (tr.type === 'schedule') {
    if (tr.kind === 'cron') return `${t('Cron: {expression}',{expression:tr.expr||''})} · ${tr.timezone||'UTC'}`
    if (tr.kind === 'every') { const minutes=Math.round((tr.everyMs||0)/60000); return t('Every {interval} minutes',{interval:minutes}) }
    if (tr.kind === 'at') return `${t('Once at')} ${tr.at&&Number.isFinite(Date.parse(tr.at))?new Date(tr.at).toLocaleString(getLocale()):tr.at||''}`
    return `${t('Schedule')}: ${t(tr.cadence || 'daily')}${tr.cadence === 'weekly' ? ` · ${weekdayName(tr.weekday ?? 1)}` : tr.cadence === 'monthly' ? ` · ${t('Day {day}',{day:tr.monthday ?? 1})}` : ''} ${String(tr.hour ?? 9).padStart(2, '0')}:${String(tr.minute ?? 0).padStart(2, '0')} ${tr.timezone || ''}`
  }
  if (tr.type === 'row') {
    const table = tables.find((x) => x.id === tr.tableId)
    const where = tr.where ? Object.entries(tr.where).map(([k, v]) => `${table?.columns.find(column=>column.id===k)?.name||k} = ${v.join('/')}`).join(', ') : ''
    return `${t('When a row is {on} in {table}', { on: tr.on || 'any', table: table?.name || tr.tableId || '?' })}${where ? ` (${where})` : ''}`
  }
  if (tr.type === 'app_record_change') {
    const app=apps.find(option=>option.app.id===tr.appId)
    const entity=app?.entities.find(option=>option.key===tr.entityId)
    const events=(tr.events||[]).map(event=>t(event==='insert'?'is added':event==='update'?'is changed':'is deleted')).join(', ')
    const where=tr.when?.where?Object.entries(tr.when.where).map(([key,value])=>`${entity?.table.columns.find(column=>column.id===key||column.name.toLowerCase()===key.toLowerCase())?.name||key} = ${Array.isArray(value)?value.join('/') : String(value)}`).join(', '):''
    return `${t('When an app record changes')} · ${app?.app.name||tr.appId||'?'} / ${entity?.table.name||tr.entityId||'?'} · ${events}${where?` (${where})`:''}`
  }
  if (tr.type === 'webhook') return t('When its webhook is called')
  return t('When someone runs it')
}

