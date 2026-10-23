import React, { useEffect, useRef, useState } from 'react'
import { Dialog } from './Dialog'
import type { AgentMemory, MemoryReview } from '../utils/harness'
import { useT } from '../utils/i18n'

type Page = { reviews: MemoryReview[]; nextCursor: string | null }
export function AgentMemoryHistory({ memory, load, onClose }: { memory: AgentMemory; load: (cursor?: string) => Promise<Page>; onClose: () => void }) {
  const t = useT()
  const [rows, setRows] = useState<MemoryReview[]>([]), [cursor, setCursor] = useState<string | null>(null)
  const [busy, setBusy] = useState(true), [error, setError] = useState('')
  const alive = useRef(true), pending = useRef(false), fetchPage = useRef(load)
  const read = async (after?: string) => {
    if (pending.current) return
    pending.current = true; setBusy(true); setError('')
    try {
      const page = await fetchPage.current(after)
      if (alive.current) { setRows(previous => after ? [...new Map([...previous, ...page.reviews].map(row => [row.id, row])).values()] : page.reviews); setCursor(page.nextCursor) }
    } catch (e) { if (alive.current) setError(e instanceof Error ? e.message : String(e)) }
    finally { pending.current = false; if (alive.current) setBusy(false) }
  }
  useEffect(() => { alive.current = true; void read(); return () => { alive.current = false } }, [])
  return <Dialog title={t('Memory review history')} onClose={onClose}>
    <p>{memory.title || memory.text}</p>
    {rows.map(row => <article className="hx-run-detail" key={row.id}>
      <strong>{row.reviewerName}</strong> · <time dateTime={row.at}>{new Date(row.at).toLocaleString()}</time>
      <p className="row-sub">{t('Reviewed version {version}', { version: row.version })}</p>
      <p className="memory-text">{row.evidence}</p>
    </article>)}
    {busy && <p role="status">{t('Loading…')}</p>}
    {error && <p className="dlg-error" role="alert">{error}</p>}
    {!busy && !error && !rows.length && <p className="empty">{t('No memory reviews yet.')}</p>}
    {!busy && (error || cursor) && <button className="dlg-btn" onClick={() => void read(cursor || undefined)}>{t(error ? 'Retry' : 'Load more')}</button>}
  </Dialog>
}
