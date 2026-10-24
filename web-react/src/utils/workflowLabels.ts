import type {StepType,Trigger,Table} from './harness'
import {getLocale} from './locale'
export const weekdayName = (day:number) => new Intl.DateTimeFormat(getLocale(),{weekday:'long',timeZone:'UTC'}).format(new Date(Date.UTC(2026,0,4+day)))

export function stepLabel(t: (k: string) => string, type: StepType) {
  return ({
    post: t('Post in a room'), agent: t('Ask an agent'), add_row: t('Add a row'),
    update_row: t('Change the row'), approval: t('Ask for approval'), followup: t('Follow up later'),
  } as Record<StepType, string>)[type]
}

export function triggerLabel(t: (k: string, v?: Record<string, string | number>) => string, tr: Trigger, tables: Table[]) {
  if (tr.type === 'schedule') return `${t('Schedule')}: ${t(tr.cadence || 'daily')}${tr.cadence === 'weekly' ? ` · ${weekdayName(tr.weekday ?? 1)}` : tr.cadence === 'monthly' ? ` · ${t('Day {day}',{day:tr.monthday ?? 1})}` : ''} ${String(tr.hour ?? 9).padStart(2, '0')}:${String(tr.minute ?? 0).padStart(2, '0')} ${tr.timezone || ''}`
  if (tr.type === 'row') {
    const table = tables.find((x) => x.id === tr.tableId)
    const where = tr.where ? Object.entries(tr.where).map(([k, v]) => `${table?.columns.find(column=>column.id===k)?.name||k} = ${v.join('/')}`).join(', ') : ''
    return `${t('When a row is {on} in {table}', { on: tr.on || 'any', table: table?.name || tr.tableId || '?' })}${where ? ` (${where})` : ''}`
  }
  if (tr.type === 'webhook') return t('When its webhook is called')
  return t('When someone runs it')
}

