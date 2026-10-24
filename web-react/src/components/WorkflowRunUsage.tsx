import React from 'react'
import type {Run} from '../utils/harness'
import {useT} from '../utils/i18n'
import {getLocale} from '../utils/locale'

export function WorkflowRunUsage({usage}:{usage:Run['usage']}){
 const t=useT(),number=(n:number)=>n.toLocaleString(getLocale())
 if(!usage?.calls)return <p className="row-sub">{t('No recorded AI usage. This does not confirm zero usage.')}</p>
 const counters=(value:{inputTokens:number;outputTokens:number;unknownCalls:number})=><>
  {t('Input tokens')}: {number(value.inputTokens)} · {t('Output tokens')}: {number(value.outputTokens)}
  {value.unknownCalls>0&&<> · {t('Responses with unknown usage')}: {number(value.unknownCalls)}</>}
 </>
 return <details className="hx-run-detail"><summary className="row-sub">{t('Recorded AI usage')} · {counters(usage)}</summary>
  <p className="form-note">{t('Provider-reported responses only. Unrecorded calls and external tool charges are not included.')}</p>
  <ol>{usage.steps.map(step=><li key={step.stepNumber}>{t('Step')} {number(step.stepNumber)} · {counters(step)}</li>)}</ol>
 </details>
}
