import React, { useId, useMemo, useState } from 'react'
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
export type IllustrationElement =
  | { type: 'rect'; x: number; y: number; width: number; height: number; rx?: number; fill?: string; stroke?: string; strokeWidth?: number }
  | { type: 'circle'; cx: number; cy: number; r: number; fill?: string; stroke?: string; strokeWidth?: number }
  | { type: 'line'; x1: number; y1: number; x2: number; y2: number; stroke?: string; strokeWidth?: number }
  | { type: 'polygon'; points: Array<[number, number]>; fill?: string; stroke?: string; strokeWidth?: number }
  | { type: 'text'; x: number; y: number; text: string; fontSize?: number; fill?: string; anchor?: 'start' | 'middle' | 'end'; bold?: boolean }
export type MessageIllustration = { type: 'illustration'; title: string; description?: string; elements: IllustrationElement[] }
export type MessageImageJob = { type: 'image_job'; title: string; jobId: string }
export type MessageVisualizationData = MessageChart | MessageExplainer | MessageIllustration | MessageImageJob
export type MessageSegment = { kind: 'text'; text: string } | { kind: 'visualization'; value: MessageVisualizationData }

const MAX_SOURCE = 16_000
const cleanText = (value: unknown, max: number) => typeof value === 'string' && value.trim().length > 0 && value.length <= max
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value))
const safeColor = (value: unknown) => typeof value === 'string' && (/^#[\da-f]{3}(?:[\da-f]{3})?$/i.test(value) || ['none', 'currentColor'].includes(value))
const coordinate = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1024
const onlyKeys = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).every(key => keys.includes(key))

function parseIllustrationElement(value: unknown): IllustrationElement | null {
  if (!isRecord(value) || typeof value.type !== 'string') return null
  const colorFields = ['fill', 'stroke']
  if (colorFields.some(key => value[key] !== undefined && !safeColor(value[key]))) return null
  const width = value.strokeWidth
  if (width !== undefined && (typeof width !== 'number' || !Number.isFinite(width) || width < 0 || width > 32)) return null
  const optionalPaint = { ...(typeof value.fill === 'string' ? { fill: value.fill } : {}), ...(typeof value.stroke === 'string' ? { stroke: value.stroke } : {}), ...(typeof width === 'number' ? { strokeWidth: width } : {}) }
  if (value.type === 'rect' && onlyKeys(value, ['type','x','y','width','height','rx','fill','stroke','strokeWidth'])
    && coordinate(value.x) && coordinate(value.y) && typeof value.width === 'number' && Number.isFinite(value.width) && value.width > 0 && value.width <= 1024 - value.x
    && typeof value.height === 'number' && Number.isFinite(value.height) && value.height > 0 && value.height <= 1024 - value.y
    && (value.rx === undefined || (typeof value.rx === 'number' && Number.isFinite(value.rx) && value.rx >= 0 && value.rx <= 64))) {
    return { type: 'rect', x: value.x, y: value.y, width: value.width, height: value.height, ...(typeof value.rx === 'number' ? { rx: value.rx } : {}), ...optionalPaint }
  }
  if (value.type === 'circle' && onlyKeys(value, ['type','cx','cy','r','fill','stroke','strokeWidth'])
    && coordinate(value.cx) && coordinate(value.cy) && typeof value.r === 'number' && Number.isFinite(value.r) && value.r > 0 && value.r <= 512
    && value.cx - value.r >= 0 && value.cx + value.r <= 1024 && value.cy - value.r >= 0 && value.cy + value.r <= 1024) {
    return { type: 'circle', cx: value.cx, cy: value.cy, r: value.r, ...optionalPaint }
  }
  if (value.type === 'line' && onlyKeys(value, ['type','x1','y1','x2','y2','stroke','strokeWidth'])
    && coordinate(value.x1) && coordinate(value.y1) && coordinate(value.x2) && coordinate(value.y2)) {
    return { type: 'line', x1: value.x1, y1: value.y1, x2: value.x2, y2: value.y2, ...optionalPaint }
  }
  if (value.type === 'polygon' && onlyKeys(value, ['type','points','fill','stroke','strokeWidth']) && Array.isArray(value.points) && value.points.length >= 3 && value.points.length <= 20
    && value.points.every(point => Array.isArray(point) && point.length === 2 && coordinate(point[0]) && coordinate(point[1]))) {
    return { type: 'polygon', points: value.points as Array<[number, number]>, ...optionalPaint }
  }
  if (value.type === 'text' && onlyKeys(value, ['type','x','y','text','fontSize','fill','anchor','bold'])
    && coordinate(value.x) && coordinate(value.y) && cleanText(value.text, 160)
    && (value.fontSize === undefined || (typeof value.fontSize === 'number' && Number.isFinite(value.fontSize) && value.fontSize >= 10 && value.fontSize <= 96))
    && (value.anchor === undefined || ['start','middle','end'].includes(String(value.anchor)))
    && (value.bold === undefined || typeof value.bold === 'boolean')) {
    return { type: 'text', x: value.x, y: value.y, text: value.text as string, ...(typeof value.fontSize === 'number' ? { fontSize: value.fontSize } : {}), ...(typeof value.fill === 'string' ? { fill: value.fill } : {}), ...(typeof value.anchor === 'string' ? { anchor: value.anchor as 'start'|'middle'|'end' } : {}), ...(typeof value.bold === 'boolean' ? { bold: value.bold } : {}) }
  }
  return null
}

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
  if (value.type === 'illustration' && onlyKeys(value, ['type','title','description','elements'])
    && (value.description === undefined || typeof value.description === 'string' && value.description.length <= 800)
    && Array.isArray(value.elements) && value.elements.length > 0 && value.elements.length <= 80) {
    const elements = value.elements.map(parseIllustrationElement)
    if (elements.some(element => element === null)) return null
    return { type: 'illustration', title: value.title as string, ...(typeof value.description === 'string' ? { description: value.description } : {}), elements: elements as IllustrationElement[] }
  }
  if (value.type === 'image_job' && onlyKeys(value, ['type','title','jobId']) && typeof value.jobId === 'string' && /^[\w-]{1,100}$/.test(value.jobId))
    return { type: 'image_job', title: value.title as string, jobId: value.jobId }
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

export type MediaJobApi = { httpBase: string; orgId: string; sessionToken: string }
export function MessageVisualization({ value, api }: { value: MessageVisualizationData; api?: MediaJobApi }) {
  return value.type === 'chart' ? <ChartCard value={value} /> : value.type === 'explainer' ? <ExplainerCard value={value} /> : value.type === 'illustration' ? <IllustrationCard value={value} /> : <ImageJobCard value={value} api={api} />
}

function ImageJobCard({value,api}:{value:MessageImageJob;api?:MediaJobApi}){
 const [job,setJob]=useState<{status:string;prompt?:string;model?:string;size?:string;quality?:string;fileId?:string;openUrl?:string;errorCode?:string}|null>(null),[busy,setBusy]=useState(false),[confirm,setConfirm]=useState(false),[error,setError]=useState('')
 const load=async()=>{
  if(!api)return
  const query=new URLSearchParams({orgId:api.orgId})
  const response=await fetch(`${api.httpBase}/hx/media-jobs/${encodeURIComponent(value.jobId)}?${query}`,{headers:{'x-session-token':api.sessionToken}})
  const data=await response.json().catch(()=>null)
  if(!response.ok||!data?.job)throw Error(data?.message||'Image job is unavailable.')
  setJob(data.job)
 }
 React.useEffect(()=>{let active=true;void load().catch(e=>active&&setError(e.message));return()=>{active=false}},[api?.httpBase,api?.orgId,api?.sessionToken,value.jobId])
 React.useEffect(()=>{if(!job||!['queued','running'].includes(job.status)||!api)return;let active=true;const timer=setInterval(()=>{void load().catch(e=>active&&setError(e.message))},3000);return()=>{active=false;clearInterval(timer)}},[job?.status,api?.httpBase,api?.orgId,api?.sessionToken,value.jobId])
 const act=async(action:'approve'|'cancel')=>{if(!api)return;setBusy(true);setError('');try{const response=await fetch(`${api.httpBase}/hx/media-jobs/${encodeURIComponent(value.jobId)}/${action}?orgId=${encodeURIComponent(api.orgId)}`,{method:'POST',headers:{'content-type':'application/json','x-session-token':api.sessionToken},body:JSON.stringify(action==='approve'?{confirmCostVariability:true}:{})});const data=await response.json().catch(()=>null);if(!response.ok||!data?.job)throw Error(data?.message||'Image request failed.');setJob(data.job);setConfirm(false)}catch(e){setError(e instanceof Error?e.message:'Image request failed.')}finally{setBusy(false)}}
 const status=job?.status
 return <section className="hx-message-visual hx-image-job" aria-label={value.title}>
  <header className="hx-message-visual-head"><div><h3>{value.title}</h3><p>{status==='awaiting_approval'?'Ready for your approval':status==='queued'?'Queued':status==='running'?'Generating image':status==='succeeded'?'Image ready':status==='failed'?'Generation failed':status==='cancelled'?'Cancelled':'Checking image job'}</p></div></header>
  {status==='awaiting_approval'&&<div className="hx-image-job-approval"><p className="hx-image-job-prompt">{job?.prompt}</p><p>{job?.model} · {job?.size} · {job?.quality}</p><p>Approving sends this prompt to OpenAI using the workspace key and incurs a variable charge. The exact amount depends on generated output. Review your provider usage limits before continuing.</p><label><input type="checkbox" checked={confirm} onChange={event=>setConfirm(event.target.checked)}/> I understand the prompt is sent to OpenAI and provider charges vary. Approve this generation.</label><button type="button" disabled={!confirm||busy} onClick={()=>void act('approve')}>{busy?'Approving…':'Approve and generate'}</button><button type="button" disabled={busy} onClick={()=>void act('cancel')}>Cancel</button></div>}
  {status==='queued'&&<p role="status">Waiting for the image worker.</p>}{status==='running'&&<p role="status">The image worker is generating your image.</p>}
  {status==='succeeded'&&job?.openUrl&&<a href={job.openUrl}>Open generated image</a>}{status==='failed'&&<p role="status">This request ended without an automatic retry. Reference: {job?.errorCode||'provider_error'}.</p>}
  {error&&<p role="alert">{error}</p>}
 </section>
}

function IllustrationCard({ value }: { value: MessageIllustration }) {
  const titleId = useId(), descriptionId = useId()
  return <section className="hx-message-visual hx-message-illustration" aria-label={value.title}>
    <header className="hx-message-visual-head"><div><h3>{value.title}</h3>{value.description && <p>{value.description}</p>}</div></header>
    <svg viewBox="0 0 1024 1024" role="img" aria-labelledby={`${titleId}${value.description ? ` ${descriptionId}` : ''}`}>
      <title id={titleId}>{value.title}</title>{value.description && <desc id={descriptionId}>{value.description}</desc>}
      {value.elements.map((element, index) => {
        if (element.type === 'rect') return <rect key={index} x={element.x} y={element.y} width={element.width} height={element.height} rx={element.rx} fill={element.fill || 'none'} stroke={element.stroke || 'none'} strokeWidth={element.strokeWidth} />
        if (element.type === 'circle') return <circle key={index} cx={element.cx} cy={element.cy} r={element.r} fill={element.fill || 'none'} stroke={element.stroke || 'none'} strokeWidth={element.strokeWidth} />
        if (element.type === 'line') return <line key={index} x1={element.x1} y1={element.y1} x2={element.x2} y2={element.y2} stroke={element.stroke || 'currentColor'} strokeWidth={element.strokeWidth || 2} />
        if (element.type === 'polygon') return <polygon key={index} points={element.points.map(point => point.join(',')).join(' ')} fill={element.fill || 'none'} stroke={element.stroke || 'none'} strokeWidth={element.strokeWidth} />
        return <text key={index} x={element.x} y={element.y} fontSize={element.fontSize || 32} fill={element.fill || 'currentColor'} textAnchor={element.anchor || 'start'} fontWeight={element.bold ? 700 : 400}>{element.text}</text>
      })}
    </svg>
  </section>
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

export function MessageVisualText({ text, renderText, api }: { text: string; renderText: (text: string) => React.ReactNode; api?: MediaJobApi }) {
  const segments = useMemo(() => splitMessageVisualizations(text), [text])
  return <>{segments.map((segment, index) => segment.kind === 'visualization'
    ? <MessageVisualization key={`visual-${index}`} value={segment.value} api={api} />
    : <React.Fragment key={`text-${index}`}>{renderText(segment.text)}</React.Fragment>)}</>
}
