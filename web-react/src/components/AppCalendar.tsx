import React, { useState } from 'react'
import { Icon } from './Icon'
import { useT } from '../utils/i18n'
import type { Row, View, Table } from '../utils/harness'

// Calendar dates are all-day values, never parsed in the browser's timezone.
export function monthDays(month: string): Array<string | null> {
  const [year, number] = month.split('-').map(Number)
  const first = new Date(Date.UTC(year, number - 1, 1))
  const count = new Date(Date.UTC(year, number, 0)).getUTCDate()
  return [...Array(first.getUTCDay()).fill(null), ...Array.from({ length: count }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`)]
}
export function shiftMonth(month: string, delta: number) {
  const [year, number] = month.split('-').map(Number)
  return new Date(Date.UTC(year, number - 1 + delta, 1)).toISOString().slice(0, 7)
}
export function AppCalendar({ view, table, onMove, onOpen }: { view: View; table: Table; onOpen?: (row: Row) => void; onMove: (row: Row, date: string) => void }) {
  const t = useT()
  const [month, setMonth] = useState(() => {
    const now = new Date()
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  })
  const title = table.columns.find(c => c.type === 'text') || table.columns[0]
  const event = (row: Row) => <div className="hx-card" key={row.id}>
    <div className="hx-card-title">{onOpen ? <button className="hx-record-title" onClick={()=>onOpen(row)} aria-label={`${String(row.values[title?.id] || t('No value'))}の詳細を開く`}>{String(row.values[title?.id] || t('No value'))}<Icon name="maximize" size={13}/></button> : String(row.values[title?.id] || t('No value'))}</div>
    <input type="date" className="hx-cell-input" aria-label={t('Date')} value={String(row.values[view.dateColumn!] || '')} onChange={e => onMove(row, e.target.value)} />
  </div>
  return <section aria-label={view.name}>
    <div className="hx-tabs">
      <button aria-label={t('Previous month')} onClick={() => setMonth(shiftMonth(month, -1))}>‹</button>
      <input type="month" aria-label={t('Month')} value={month} onChange={e => { if (/^\d{4}-\d{2}$/.test(e.target.value)) setMonth(e.target.value) }} />
      <button aria-label={t('Next month')} onClick={() => setMonth(shiftMonth(month, 1))}>›</button>
    </div>
    <div className="hx-calendar-scroll"><div className="hx-calendar">
      {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(day => <strong key={day}>{t(day)}</strong>)}
      {monthDays(month).map((day, index) => <div className="hx-calendar-day" key={day || `blank-${index}`}>
        {day && <><time dateTime={day}>{Number(day.slice(-2))}</time>{(view.days?.find(d => d.date === day)?.rows || []).map(event)}</>}
      </div>)}
    </div></div>
    {!!view.undated?.length && <div><h3>{t('No date')}</h3>{view.undated.map(event)}</div>}
  </section>
}
