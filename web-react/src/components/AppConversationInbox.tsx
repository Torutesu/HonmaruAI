import React,{useEffect,useRef,useState} from 'react'
import type {HarnessApi} from '../utils/harness'
import {useT} from '../utils/i18n'
import {Icon} from './Icon'
type Item={messageId:number;body:string;tableId:string;rowId:string;readAt:string|null;kind:string}
export function AppConversationInbox({api,appId,onOpen}:{api:HarnessApi;appId:string;onOpen:(scope:{tableId?:string;rowId?:string})=>void}){
 const t=useT()
 const tRef=useRef(t);tRef.current=t
 const epoch=useRef(0)
 const [items,setItems]=useState<Item[]>([]),[open,setOpen]=useState(false),[error,setError]=useState('')
 useEffect(()=>{++epoch.current;let active=true;setItems([]);setOpen(false);const load=()=>{if(api.conversationNotifications)void api.conversationNotifications(appId).then(r=>{if(active){setItems(r.items);setError('')}},()=>{if(active){setItems([]);setError(tRef.current('Could not load notifications.'))}})};load();const timer=setInterval(()=>{if(document.visibilityState==='visible')load()},15000);return()=>{++epoch.current;active=false;clearInterval(timer)}},[api,appId])
 const unread=items.some(i=>!i.readAt)
 const label=t(unread?'Conversation notifications (unread)':'Conversation notifications')
 return <div className="hx-app-notifications"><button type="button" className="hx-app-icon-button" aria-label={label} aria-expanded={open} onClick={()=>setOpen(!open)}><Icon name="bell" size={16}/>{unread&&<i/>}</button>{open&&<div className="hx-app-notification-list" role="region" aria-label={label}><strong>{label}</strong>{error&&<p role="alert">{error}</p>}{!items.length?<p>{t('No new notifications')}</p>:items.map(item=><button type="button" key={item.messageId} className={item.readAt?'':'unread'} onClick={async()=>{const generation=epoch.current;try{await api.readConversationNotification(appId,item.messageId);if(generation!==epoch.current)return;setItems(prev=>prev.map(i=>i.messageId===item.messageId?{...i,readAt:new Date().toISOString()}:i));onOpen(item.rowId?{tableId:item.tableId,rowId:item.rowId}:{});setOpen(false)}catch{if(generation===epoch.current)setError(t('Could not open notification.'))}}}><small>{t(item.kind==='ai'?'AI reply':'You were mentioned')} · {t(item.rowId?'Record':'App')}</small><span>{item.body}</span></button>)}</div>}</div>
}
