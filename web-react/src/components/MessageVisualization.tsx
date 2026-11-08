import React, { useMemo, useState } from 'react'
import { renderRich } from './MessageParts'

export type MessageChart = {
  type: 'chart'
  title: string
  chart: 'bar' | 'line'
  categories: string[]
  series: Array<{ name: string; values: number[] }>
}
export type MessageExplainer = {
  type: 'explainer'
  title: string
  summary?: string
  sections: Array<{ title: string; body: string }>
}
export type MessageVisualizationData = MessageChart | MessageExplainer
export type MessageSegment = { kind: 'text'; text: string } | { kind: 'visualization'; value: MessageVisualizationData }

const MAX_SOURCE = 16_000
const cleanText = (value: unknown, max: number) => typeof value === 'string' && value.trim().length > 0 && value.length <= max
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value))

export function parseMessageVisualization(source: string): MessageVisualizationData | null {
  if (source.length > MAX_SOURCE) return null
  let value: unknown
  try { value = JSON.parse(source) } catch { return null }
  if (!isRecord(value) || !cleanText(value.title, 120)) return null
  if (value.type === 'chart') {
    if (!['bar', 'line'].includes(String(value.chart)) || !Array.isArray(value.categories) || value.categories.length < 1 || value.categories.length > 20
      || value.categories.some(label => !cleanText(label, 80)) || !Array.isArray(value.series) || value.series.length < 1 || value.series.length > 4) return null
    const categories = value.categories as string[]
    const series: MessageChart['series'] = []
    for (const item of value.series) {
      if (!isRecord(item) || !cleanText(item.name, 80) || !Array.isArray(item.values) || item.values.length !== categories.length
        || item.values.some(point => typeof point !== 'number' || !Number.isFinite(point) || Math.abs(point) > 1_000_000_000_000)) return null
      series.push({ name: item.name as string, values: item.values as number[] })
    }
    return { type: 'chart', title: value.title as string, chart: value.chart as 'bar' | 'line', categories, series }
  }
  if (value.type === 'explainer') {
    if (value.summary !== undefined && (typeof value.summary !== 'string' || value.summary.length > 800) || !Array.isArray(value.sections)
      || value.sections.length < 1 || value.sections.length > 8 || value.sections.some(section => !isRecord(section)
        || !cleanText(section.title, 120) || typeof section.body !== 'string' || !section.body.trim() || section.body.length > 2000)) return null
    return { type: 'explainer', title: value.title as string, ...(typeof value.summary === 'string' ? { summary: value.summary } : {}),
      sections: value.sections.map(section => ({ title: section.title as string, body: section.body as string })) }
  }
  return null
}

const VISUAL_BLOCK = /^```honmaru-visual\s*\n([\s\S]*?)\n```\s*$/gm

export function splitMessageVisualizations(source: string): MessageSegment[] {
  const segments: MessageSegment[] = []
  let cursor = 0
  for (const match of source.matchAll(VISUAL_BLOCK)) {
    const start = match.index ?? 0
    if (start > cursor) segments.push({ kind: 'text', text: source.slice(cursor, start) })
    const value = parseMessageVisualization(match[1])
    if (value) segments.push({ kind: 'visualization', value })
    else segments.push({ kind: 'text', text: match[0] })
    cursor = start + match[0].length
  }
  if (cursor < source.length) segments.push({ kind: 'text', text: source.slice(cursor) })
  return segments.length ? segments : [{ kind: 'text', text: source }]
}

const PALETTE = ['var(--hx-accent, #6657d9)', '#1d9a80', '#d1872a', '#cf6072']

export function MessageVisualization({ value }: { value: MessageVisualizationData }) {
  return value.type === 'chart' ? <ChartCard value={value} /> : <ExplainerCard value={value} />
}

function ChartCard({ value }: { value: MessageChart }) {
  const [view, setView] = useState<'chart' | 'data'>('chart')
  const [visible, setVisible] = useState<number[]>(() => value.series.map((_, index) => index))
  const active = value.series.filter((_, index) => visible.includes(index))
  const points = active.flatMap(series => series.values)
  let min = Math.min(0, ...points), max = Math.max(0, ...points)
  if (max === min) { max += 1; min -= 1 }
  const left = 54, right = 700, top = 28, bottom = 224
  const y = (point: number) => top + (max - point) / (max - min) * (bottom - top)
  const zero = y(0)
  const groupWidth = (right - left) / value.categories.length
  const money = (point: number) => new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(point)
  const allHidden = visible.length === 0
  return <section className="hx-message-visual" aria-label={value.title}>
    <header className="hx-message-visual-head"><div><h3>{value.title}</h3><p>{value.chart === 'bar' ? 'Bar chart' : 'Line chart'}</p></div>
      <div className="hx-message-visual-tabs"><button type="button" aria-pressed={view === 'chart'} onClick={() => setView('chart')}>Chart</button><button type="button" aria-pressed={view === 'data'} onClick={() => setView('data')}>Data</button></div>
    </header>
    {view === 'chart' ? <div className="hx-message-chart-scroll"><svg viewBox="0 0 720 270" role="img" aria-label={`${value.title} ${value.chart} chart`}>
      {[0, .5, 1].map((fraction, index) => { const valueY = top + fraction * (bottom - top); const label = max - fraction * (max - min); return <g key={index}><line x1={left} x2={right} y1={valueY} y2={valueY} className="hx-message-chart-grid"/><text x={left - 8} y={valueY + 4} textAnchor="end" className="hx-message-chart-label">{money(label)}</text></g> })}
      <line x1={left} x2={right} y1={zero} y2={zero} className="hx-message-chart-axis" />
      {value.chart === 'bar' && active.map((series, activeIndex) => {
        const originalIndex = value.series.indexOf(series)
        const slot = Math.min(18, groupWidth * .18)
        const totalWidth = slot * active.length
        return series.values.map((point, index) => {
          const x = left + groupWidth * index + (groupWidth - totalWidth) / 2 + activeIndex * slot
          const valueY = y(point)
          return <g key={`${originalIndex}-${index}`}><rect x={x} y={Math.min(zero, valueY)} width={Math.max(5, slot - 3)} height={Math.max(1, Math.abs(zero - valueY))} rx="3" fill={PALETTE[originalIndex % PALETTE.length]}><title>{`${series.name} · ${value.categories[index]}: ${money(point)}`}</title></rect></g>
        })
      })}
      {value.chart === 'line' && active.map(series => {
        const originalIndex = value.series.indexOf(series)
        const coords = series.values.map((point, index) => `${left + groupWidth * (index + .5)},${y(point)}`).join(' ')
        return <g key={originalIndex}><polyline points={coords} fill="none" stroke={PALETTE[originalIndex % PALETTE.length]} strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" />{series.values.map((point, index) => <circle key={index} cx={left + groupWidth * (index + .5)} cy={y(point)} r="5" fill={PALETTE[originalIndex % PALETTE.length]}><title>{`${series.name} · ${value.categories[index]}: ${money(point)}`}</title></circle>)}</g>
      })}
      {value.categories.map((label, index) => <text key={index} x={left + groupWidth * (index + .5)} y="250" textAnchor="middle" className="hx-message-chart-label"><title>{label}</title>{label.length > 11 ? `${label.slice(0, 10)}…` : label}</text>)}
    </svg>{allHidden && <p className="hx-message-chart-empty" role="status">Choose a series to display.</p>}</div>
      : <div className="hx-message-chart-data"><table><caption>{value.title}</caption><thead><tr><th scope="col">Category</th>{active.map((series, index) => <th key={`${series.name}-${index}`} scope="col">{series.name}</th>)}</tr></thead><tbody>{value.categories.map((category, row) => <tr key={`${category}-${row}`}><th scope="row">{category}</th>{active.map((series, index) => <td key={`${series.name}-${index}`}>{money(series.values[row])}</td>)}</tr>)}</tbody></table></div>}
    <div className="hx-message-chart-legend">{value.series.map((series, index) => <button key={index} type="button" aria-label={series.name} aria-pressed={visible.includes(index)} onClick={() => setVisible(current => current.includes(index) ? current.filter(item => item !== index) : [...current, index])}><i style={{ background: PALETTE[index % PALETTE.length] }} />{series.name}</button>)}</div>
  </section>
}

function ExplainerCard({ value }: { value: MessageExplainer }) {
  const [open, setOpen] = useState(0)
  return <section className="hx-message-visual hx-message-explainer" aria-label={value.title}>
    <header className="hx-message-visual-head"><div><h3>{value.title}</h3>{value.summary && <p>{value.summary}</p>}</div></header>
    <nav className="hx-message-explainer-tabs" aria-label="Sections">{value.sections.map((section, index) => <button key={index} type="button" aria-pressed={open === index} onClick={() => setOpen(index)}><span>{index + 1}</span>{section.title}</button>)}</nav>
    <article className="hx-message-explainer-content"><h4>{value.sections[open].title}</h4><div>{renderRich(value.sections[open].body, () => '')}</div></article>
    {value.sections.length > 1 && <footer><button type="button" disabled={open === 0} onClick={() => setOpen(index => Math.max(0, index - 1))}>Previous</button><span>{open + 1} / {value.sections.length}</span><button type="button" disabled={open === value.sections.length - 1} onClick={() => setOpen(index => Math.min(value.sections.length - 1, index + 1))}>Next</button></footer>}
  </section>
}

export function MessageVisualText({ text, renderText }: { text: string; renderText: (text: string) => React.ReactNode }) {
  const segments = useMemo(() => splitMessageVisualizations(text), [text])
  return <>{segments.map((segment, index) => segment.kind === 'visualization'
    ? <MessageVisualization key={`visual-${index}`} value={segment.value} />
    : <React.Fragment key={`text-${index}`}>{renderText(segment.text)}</React.Fragment>)}</>
}
