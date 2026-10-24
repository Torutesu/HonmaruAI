import React from 'react'
import {WorkflowConditionEditor,blankCondition} from './WorkflowConditionEditor'
import {useT} from '../utils/i18n'
import {Icon} from './Icon'
import type {Step,StepType,Table} from '../utils/harness'
export interface AgentFace {id:string;handle:string;name:string;emoji?:string|null}
const STEP_TYPES:StepType[]=['post','agent','add_row','update_row','approval','followup']
const blankStep=(type:StepType):Step=>({type,...(type==='followup'?{minutes:1440}:{})})
function stepLabel(t: (k: string) => string, type: StepType) {
  return ({
    post: t('Post in a room'), agent: t('Ask an agent'), add_row: t('Add a row'),
    update_row: t('Change the row'), approval: t('Ask for approval'), followup: t('Follow up later'),
  } as Record<StepType, string>)[type]
}

export function StepEditor({ step, onChange, onRemove, tables, agents, triggerTable }: {
  step: Step; onChange: (s: Step) => void; onRemove: () => void; tables: Table[]; agents: AgentFace[]; triggerTable?: Table
}) {
  const t = useT()
  const set = (patch: Partial<Step>) => onChange({ ...step, ...patch })
  const valueTable = step.type === 'add_row' ? tables.find((x) => x.id === step.tableId) : triggerTable
  return (
    <div className="hx-step">
      <div className="hx-step-head">
        <select value={step.type} onChange={(e) => onChange({...blankStep(e.target.value as StepType),...(step.when?{when:step.when}:{})})} aria-label={t('Step')}>
          {STEP_TYPES.map((s) => <option key={s} value={s}>{stepLabel(t, s)}</option>)}
        </select>
        <button className="btn-text danger" onClick={onRemove} aria-label={t('Remove step')}><Icon name="x" size={14} /></button>
      </div>
      <div className="hx-step-condition"><label><input type="checkbox" checked={Boolean(step.when)} onChange={event=>set({when:event.target.checked?blankCondition():undefined})}/> {t('Run only when the condition matches')}</label>{step.when&&<WorkflowConditionEditor columns={triggerTable?.columns} value={step.when} onChange={when=>set({when})}/>}</div>
      {(step.type === 'post' || step.type === 'followup') && (
        <input className="hx-cell-input" placeholder="#ops" value={(step.channel || '').replace(/^b:/, '#')} onChange={(e) => set({ channel: `b:${e.target.value.replace(/^#/, '')}` })} aria-label={t('Room')} />
      )}
      {(step.type === 'post' || step.type === 'followup') && (
        <textarea className="context-input" rows={2} placeholder={t('e.g. {{row.Client}} is overdue')} value={step.text || ''} onChange={(e) => set({ text: e.target.value })} aria-label={t('Text')} />
      )}
      {step.type === 'followup' && (
        <label className="hx-inline">{t('In')} <input type="number" min={1} max={129600} step={1} aria-label={t('Follow-up delay (minutes)')} className="hx-cell-input hx-num" value={step.minutes ?? 1440} onChange={(e) => set({ minutes: Number(e.target.value) })} /> {t('minutes')}</label>
      )}
      {step.type === 'agent' && (
        <>
          <select value={step.agentId || ''} onChange={(e) => set({ agentId: e.target.value })} aria-label={t('Agent')}>
            <option value="">{t('Choose an agent')}</option>
            {agents.map((a) => <option key={a.id} value={a.id}>{a.emoji ? `${a.emoji} ` : ''}{a.name} (@{a.handle})</option>)}
          </select>
          <textarea className="context-input" rows={2} placeholder={t('What to ask it')} value={step.prompt || ''} onChange={(e) => set({ prompt: e.target.value })} aria-label={t('Prompt')} />
          <input className="hx-cell-input" placeholder={t('#room to post its answer (optional)')} value={(step.channel || '').replace(/^b:/, '#')} onChange={(e) => set({ channel: e.target.value ? `b:${e.target.value.replace(/^#/, '')}` : undefined })} aria-label={t('Room')} />
        </>
      )}
      {step.type === 'add_row' && (
        <select value={step.tableId || ''} onChange={(e) => set({ tableId: e.target.value, values: {} })} aria-label={t('Table')}>
          <option value="">{t('Choose a table')}</option>
          {tables.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
        </select>
      )}
      {(step.type === 'add_row' || step.type === 'update_row') && valueTable && (
        <div className="hx-values">
          {valueTable.columns.map((c) => (
            <label key={c.id} className="hx-inline">
              <span>{c.name}</span>
              <input className="hx-cell-input" value={step.values?.[c.id] || ''} placeholder={c.type === 'select' ? (c.options || []).join(' / ') : ''} onChange={(e) => set({ values: { ...(step.values || {}), [c.id]: e.target.value } })} />
            </label>
          ))}
        </div>
      )}
      {step.type === 'update_row' && !valueTable && <div className="row-sub">{t('Changes the row that started the run: use a row trigger.')}</div>}
      {step.type === 'approval' && (
        <>
          <input className="hx-cell-input" placeholder={t('@who approves')} value={step.to ? `@${step.to}` : ''} onChange={(e) => set({ to: e.target.value.replace(/^@/, '') })} aria-label={t('Approver')} />
          <input className="hx-cell-input" placeholder={t('e.g. Send {{row.Client}} a reminder?')} value={step.title || ''} onChange={(e) => set({ title: e.target.value })} aria-label={t('Title')} />
          <textarea className="context-input" rows={2} placeholder={t('What they should know')} value={step.summary || ''} onChange={(e) => set({ summary: e.target.value })} aria-label={t('Summary')} />
        </>
      )}
    </div>
  )
}

