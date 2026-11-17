import React from 'react'
import {useT} from '../utils/i18n'

export type WorkspaceSearchProgressState = {
  step:'messages'|'resources'|'done'|'error'
  threads?:number
  rooms?:number
  messages?:number
  files?:number
  records?:number
}

export function WorkspaceFindProgress({progress,error}:{progress:WorkspaceSearchProgressState;error:string}){
 const t=useT(),value=progress.step==='messages'?24:progress.step==='resources'?72:100
 const label=progress.step==='messages'?t('Searching messages across your workspace…')
  :progress.step==='resources'&&progress.threads!==undefined?t('Found {threads} threads across {rooms} Rooms; searching files and app records…',{threads:progress.threads,rooms:progress.rooms||0})
  :progress.step==='resources'?t('Searching accessible files and app records…')
  :progress.step==='error'?error
  :t('Found {threads} threads across {rooms} Rooms; showing {messages} messages, {files} files and {records} app records.',{
   threads:progress.threads||0,rooms:progress.rooms||0,messages:progress.messages||0,files:progress.files||0,records:progress.records||0,
  })
 return <div className={`palette-search-progress${progress.step==='error'?' is-error':''}`} role="status" aria-live="polite" data-search-step={progress.step}>
  {progress.step!=='error'&&<div className="palette-search-progress-track" role="progressbar" aria-label={t('Workspace search progress')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={value}><span style={{width:`${value}%`}}/></div>}
  <span>{label}</span>
 </div>
}
