import React, { useRef } from 'react'
import type { Proposal, Report } from '../types/card'
import { Markdown } from '../utils/markdown'
import { reportFileName } from '../utils/automation'
import { hashForCard } from '../utils/route'
import { getLocale } from '../utils/locale'
import { useT } from '../utils/i18n'

/// "15 Sep – 22 Sep", in the reader's calendar. One date when the period is
/// one day.
function period(startIso: string, endIso: string): string {
  const locale = getLocale()
  const day = (iso: string) => {
    const d = new Date(iso)
    return Number.isFinite(d.getTime()) ? d.toLocaleDateString(locale, { month: 'short', day: 'numeric' }) : ''
  }
  const a = day(startIso)
  const b = day(endIso)
  if (!a || !b) return a || b
  return a === b ? a : `${a} – ${b}`
}

/// A routine's report, as a document: what the AI wrote, where it drew from,
/// and a way to take it elsewhere — a Markdown file, or paper.
export const ReportDoc: React.FC<{ report: Report; title: string }> = ({ report, title }) => {
  const t = useT()
  const doc = useRef<HTMLDivElement>(null)
  const when = period(report.periodStart, report.periodEnd)
  const sources = (report.sources || []).filter((s) => s.title)

  const download = () => {
    const body = /^#\s/.test(report.markdown.trimStart()) ? report.markdown : `# ${title}\n\n${report.markdown}`
    const url = URL.createObjectURL(new Blob([`${body.trimEnd()}\n`], { type: 'text/markdown;charset=utf-8' }))
    const a = document.createElement('a')
    a.href = url
    a.download = reportFileName(title)
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  // Printing the page would print the feed around the report. A copy of the
  // report goes into a root of its own, the print stylesheet shows only that,
  // and the copy leaves when the dialog does. The document's title becomes
  // the report's, which is the name "Save as PDF" offers.
  const print = () => {
    const node = doc.current
    if (!node) return
    const root = document.createElement('div')
    root.className = 'print-root'
    root.appendChild(node.cloneNode(true))
    document.body.appendChild(root)
    document.body.classList.add('printing-report')
    const before = document.title
    document.title = title
    let done = false
    const cleanUp = () => {
      if (done) return
      done = true
      root.remove()
      document.body.classList.remove('printing-report')
      document.title = before
      window.removeEventListener('afterprint', cleanUp)
    }
    window.addEventListener('afterprint', cleanUp)
    window.print()
    // print() blocks in most browsers; where it does not, afterprint says when.
    setTimeout(cleanUp, 1500)
  }

  return (
    <section className="report" aria-label={t('Report')}>
      <div className="report-doc" ref={doc}>
        <h1 className="report-print-title">{title}</h1>
        <div className="report-meta">
          {report.schedule}
          {when && <> · {when}</>}
          {report.by === 'digest' && <> · {t('Digest, no model used')}</>}
        </div>
        <Markdown source={report.markdown} className="report-body" />
        {sources.length > 0 && (
          <ul className="answer-sources report-sources" aria-label={t('From your tools')}>
            {sources.map((s) => (
              <li key={`${s.app}-${s.title}`}>
                <span className="answer-when">{s.app}</span>
                {s.url && /^https?:\/\//i.test(s.url) ? <a href={s.url} target="_blank" rel="noopener noreferrer">{s.title}</a> : s.title}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="report-actions">
        <button type="button" className="pill-btn quiet" onClick={download}>{t('Download .md')}</button>
        <button type="button" className="pill-btn quiet" onClick={print}>{t('Print / Save as PDF')}</button>
      </div>
    </section>
  )
}

/// Why your AI is offering to automate something: the requests it noticed.
/// Approving the card is what sets the routine up.
export const ProposalNote: React.FC<{ proposal: Proposal }> = ({ proposal }) => {
  const t = useT()
  const locale = getLocale()
  const evidence = (proposal.evidence || []).slice(-5)
  return (
    <section className="proposal">
      {proposal.routine?.instruction && <blockquote className="rb-quote proposal-what">{proposal.routine.instruction}</blockquote>}
      {evidence.length > 0 && (
        <>
          <div className="rb-label">{t('You asked for this on')}</div>
          <ul className="answer-sources proposal-evidence">
            {evidence.map((e) => (
              <li key={e.id}>
                <span className="answer-when">{new Date(e.createdAt).toLocaleDateString(locale, { month: 'short', day: 'numeric' })}</span>
                <a href={hashForCard(e.id)}>{e.title}</a>
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="proposal-note">{t('Approve to set it up; decline and it is not offered again. You can change or stop it any time under Automations.')}</p>
    </section>
  )
}
