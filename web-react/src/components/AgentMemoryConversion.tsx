import React, { useEffect, useRef, useState } from 'react'
import { Dialog } from './Dialog'
import type { AgentMemory } from '../utils/harness'
import { useT } from '../utils/i18n'
import './AgentMemoryEditor.css'

export function AgentMemoryConversion({ memory, agentName, conversationName, onClose, onSave }: {
  memory: AgentMemory; agentName: string; conversationName?: string; onClose: () => void;
  onSave: (keepEntry: boolean, requestId: string) => Promise<void>
}) {
  const t=useT(), pending=useRef(false), errorElement=useRef<HTMLParagraphElement>(null)
  const [keep,setKeep]=useState(false), [requestId,setRequestId]=useState(()=>crypto.randomUUID())
  const [busy,setBusy]=useState(false), [error,setError]=useState('')
  useEffect(()=>{if(error)errorElement.current?.scrollIntoView({block:'nearest'})},[error])
  const close=()=>{if(!pending.current)onClose()}
  const save=async()=>{
    if(pending.current)return
    pending.current=true;setBusy(true);setError('')
    try {await onSave(keep,requestId);onClose()}
    catch(e){setError(e instanceof Error?e.message:String(e))}
    finally {pending.current=false;setBusy(false)}
  }
  return <Dialog title={t('Convert memory to skill')} className="hx-memory-editor hx-memory-conversion" onClose={close} footer={<>
    <button className="dlg-btn" disabled={busy} onClick={close}>{t('Cancel')}</button>
    <button className="dlg-btn primary" disabled={busy} onClick={()=>void save()}>{t(busy?'Converting…':'Create and install skill')}</button>
  </>}>
    <strong>{memory.title || memory.text}</strong>
    {memory.description && <p>{memory.description}</p>}
    <details className="hx-run-detail"><summary>{t('Memory body')}</summary><pre>{memory.body || memory.text}</pre></details>
    <p>{t('Install on {agent}',{agent:agentName})}</p>
    <p className="dlg-hint">{memory.channel?t('This skill stays restricted to {conversation} and this agent. Current access is checked whenever it is used.',{conversation:conversationName || t('Conversation memory')}):t('This skill stays restricted to this agent and people who can access it.')}</p>
    <label><input type="checkbox" checked={keep} disabled={busy} onChange={e=>{setKeep(e.target.checked);setRequestId(crypto.randomUUID());setError('')}}/> {t('Keep the source memory')}</label>
    <p className="dlg-hint">{t(keep?'The original memory remains unchanged.':'The source memory is removed only after the complete skill is created and installed. A failed conversion leaves it unchanged.')}</p>
    {error && <p ref={errorElement} className="dlg-error" role="alert">{t(error)}</p>}
  </Dialog>
}
