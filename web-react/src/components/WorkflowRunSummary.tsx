import React from 'react'
import type {WorkflowRunSummary} from '../utils/harness'
import {useT} from '../utils/i18n'
import {getLocale} from '../utils/locale'
import {formatElapsedDuration} from '../utils/runDuration'

export function WorkflowRunSummaryCard({summary}:{summary:WorkflowRunSummary|null}) {
 const t=useT()
 return <section className="hx-run-summary" aria-label={t('Last 7 days')}>
  {summary ? <>
   <header><div><h3>{t('Last 7 days')}</h3><p>{t('Rolling 168 hours · UTC')}</p></div><span>{t('{count} runs',{count:summary.runCount.toLocaleString(getLocale())})}</span></header>
   <div className="hx-run-summary-metrics">
    <div><span>{t('Typical duration')}</span><strong>{summary.typicalDurationMs===null?t('No completed runs'):formatElapsedDuration(new Date(0).toISOString(),new Date(summary.typicalDurationMs).toISOString(),getLocale())}</strong><small>{t('Median of {count} completed runs',{count:summary.completedDurationCount.toLocaleString(getLocale())})}</small></div>
    <div><span>{t('Estimated AI usage')}</span><strong>{new Intl.NumberFormat(getLocale(),{style:'currency',currency:'USD',maximumFractionDigits:6}).format(summary.usage.estimatedMicros/1_000_000)}</strong><small>{t('Recorded on {count} runs',{count:summary.usage.trackedRuns.toLocaleString(getLocale())})} · {t('{count} failed runs',{count:summary.failedCount.toLocaleString(getLocale())})}</small></div>
   </div>
   <p className="hx-run-summary-note">
    {t('Provider-reported token estimate only. This is not provider credits or an invoice; unpriced and unreported usage is excluded.')}
    {summary.usage.unpricedCalls>0&&<>{' · '}{t('{count} unpriced calls',{count:summary.usage.unpricedCalls.toLocaleString(getLocale())})}</>}
    {summary.usage.unknownCalls>0&&<>{' · '}{t('{count} calls with unknown token usage',{count:summary.usage.unknownCalls.toLocaleString(getLocale())})}</>}
   </p>
   {summary.runCount===0&&<p className="hx-run-empty">{t('No runs in the last 7 days.')}</p>}
   {summary.usage.calls===0&&<p className="hx-run-empty">{t('No recorded AI usage. This does not confirm zero usage.')}</p>}
   {summary.truncated&&<p className="hx-run-empty">{t('Showing a partial summary: this workflow exceeded the 5,000-run summary limit.')}</p>}
  </> : <p className="hx-run-empty">{t('Summary unavailable. Reload to try again.')}</p>}
 </section>
}
