import React, { useEffect, useId, useRef, useState } from 'react'
import type { Skill } from '../utils/harness'
import { useT } from '../utils/i18n'
import { Icon } from './Icon'
import { SkillActionsMenu } from './SkillActionsMenu'
import './AgentSkillCatalog.css'

type SkillDraft = Pick<Skill, 'name' | 'description' | 'body' | 'metadata'>

export function AgentSkillCatalog({ skills, installed, canEdit, onToggle, onPreviewImport, onSaveImport }: { onPreviewImport?: (markdown: string) => Promise<SkillDraft>; onSaveImport?: (draft: SkillDraft) => Promise<void>; skills: Skill[]; installed: Skill[]; canEdit: boolean; onToggle: (id: string, install: boolean) => Promise<void> }) {
  const t = useT(), titleId = useId(), panelId = useId()
  const [open, setOpen] = useState(false), [query, setQuery] = useState(''), [tab, setTab] = useState<'available' | 'installed'>('available')
  const [busy, setBusy] = useState<string | null>(null), [error, setError] = useState('')
  const [draft, setDraft] = useState<SkillDraft | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const pending = useRef(false), dialog = useRef<HTMLDialogElement>(null), trigger = useRef<HTMLButtonElement>(null)
  const has = new Set(installed.map(s => s.id))
  const available = skills.filter(s => !has.has(s.id))
  const visible = (tab === 'available' ? available : installed).filter(s => `${s.name} ${s.description} ${s.createdByName || ''} ${s.createdBy || ''}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
  useEffect(() => {
    if (!open) return
    dialog.current?.showModal()
    dialog.current?.querySelector<HTMLInputElement>('input[type=search]')?.focus()
    return () => { dialog.current?.close(); trigger.current?.focus() }
  }, [open])
  const close = () => { if (!pending.current) setOpen(false) }
  const toggle = async (id: string, install: boolean) => {
    if (!canEdit || pending.current) return
    pending.current = true; setBusy(id); setError('')
    try { await onToggle(id, install) } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { pending.current = false; setBusy(null) }
  }
  const importFile = async (file: File) => {
    if (!canEdit || !onPreviewImport || pending.current) return
    pending.current = true; setBusy('import'); setError('')
    try {
      if (!/\.md$/i.test(file.name) || file.size > 65536) throw new Error(t('Choose a SKILL.md file no larger than 64 KiB.'))
      setDraft(await onPreviewImport(await file.text()))
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { pending.current = false; setBusy(null) }
  }
  const saveImport = async () => {
    if (!canEdit || !draft || !onSaveImport || pending.current) return
    pending.current = true; setBusy('import'); setError('')
    try { await onSaveImport(draft); setDraft(null); setTab('available'); setQuery('') }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { pending.current = false; setBusy(null) }
  }
  const row = (s: Skill, catalog = false) => <div className="hx-skill-entry" key={s.id}>
    <span className="hx-skill-symbol"><Icon name="book" size={19}/></span>
    <div className="hx-skill-entry-copy"><div><strong>{s.name}</strong>{s.createdBy && <span className="hx-skill-author">{t('Created by')}: {s.createdByName || s.createdBy}</span>}</div><p>{s.description || s.body.slice(0, 140)}</p></div>
    {canEdit && (catalog ? <button className="hx-skill-action" disabled={busy !== null} onClick={() => void toggle(s.id, !has.has(s.id))}>{busy === s.id ? t('Saving…') : t(has.has(s.id) ? 'Remove from agent' : 'Install')}</button> : <SkillActionsMenu name={s.name} disabled={busy !== null} onRemove={() => void toggle(s.id, false)}/>)}
  </div>
  return <section className="hx-agent-skills">
    <header><p>{t('Add skills to extend this agent’s capabilities.')}</p><button className="hx-skill-add" ref={trigger} disabled={!canEdit || busy !== null} onClick={() => {setQuery('');setTab('available');setError('');setDraft(null);setOpen(true)}}><Icon name="plus" size={16}/>{t('Add skills')}</button></header>
    {!open && error && <p role="alert" className="form-error">{error}</p>}
    <div className="hx-installed-skills">{installed.map(s => row(s))}{!installed.length && <p className="empty">{t('No skills installed for this agent.')}</p>}</div>
    {open && <dialog ref={dialog} className="hx-skill-dialog" aria-labelledby={titleId} onCancel={e => {e.preventDefault();close()}} onClick={e => {if(e.target === e.currentTarget) {const r=e.currentTarget.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)close()}}}>
      <header><h2 id={titleId}>{t('Add skills')}</h2><button disabled={busy !== null} aria-label={t('Close')} onClick={close}><Icon name="x" size={18}/></button></header>
      {canEdit && onPreviewImport && onSaveImport && <section className="hx-skill-import" onDragOver={e => e.preventDefault()} onDrop={e => {e.preventDefault();const file=e.dataTransfer.files[0];if(file)void importFile(file)}}>
        <Icon name="file" size={22}/><div><strong>{t('Import a skill')}</strong><p>{t('Drop SKILL.md here or choose a file')}</p></div>
        <input ref={fileInput} type="file" accept=".md,text/markdown" hidden aria-label={t('Skill file')} onChange={e=>{const file=e.target.files?.[0];e.target.value='';if(file)void importFile(file)}}/>
        <button className="hx-skill-action" disabled={busy!==null} onClick={()=>fileInput.current?.click()}>{t('Choose file')}</button>
      </section>}
      {busy === 'import' && <p role="status">{t('Processing skill…')}</p>}
      {draft && <section className="hx-skill-import-review" aria-label={t('Review skill import')}><strong>{draft.name}</strong><p>{draft.description}</p><pre>{draft.body}</pre><p>{t('Save as a private skill, then install it for this agent from the catalog.')}</p><div><button className="hx-skill-action" disabled={busy!==null} onClick={()=>setDraft(null)}>{t('Cancel')}</button><button className="hx-skill-action" disabled={busy!==null} onClick={()=>void saveImport()}>{t('Save')}</button></div></section>}
      <input type="search" autoFocus value={query} aria-label={t('Search skills by name, author or description')} placeholder={t('Search skills by name, author or description')} onChange={e => setQuery(e.target.value)}/>
      <div className="hx-skill-catalog-tabs" role="tablist" aria-label={t('Skills')}>
        {(['available','installed'] as const).map(key => <button key={key} role="tab" id={`${panelId}-${key}`} aria-controls={panelId} aria-selected={tab===key} tabIndex={tab===key?0:-1} onClick={()=>setTab(key)} onKeyDown={e=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(e.key)){e.preventDefault();const next=e.key==='Home'?'available':e.key==='End'?'installed':key==='available'?'installed':'available';setTab(next);e.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role=tab]')[next==='available'?0:1]?.focus()}}}>{t(key==='available'?'Available':'Installed')} ({key==='available'?available.length:installed.length})</button>)}
      </div>
      {error && <p role="alert" className="form-error">{error}</p>}
      <div id={panelId} role="tabpanel" aria-labelledby={`${panelId}-${tab}`} className="hx-skill-catalog-results">{visible.map(s=>row(s,true))}{!visible.length&&<p className="empty">{t(query.trim()?'No skills match your search.':tab==='available'?'All available skills are installed.':'No skills installed for this agent.')}</p>}</div>
    </dialog>}
  </section>
}
