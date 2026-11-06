import React,{useEffect,useRef,useState} from 'react'
import {Icon} from './Icon'
import {dictationAvailable,startDictation,type Dictation,readDictationVocabulary,writeDictationVocabulary} from '../utils/dictation'
import {useT} from '../utils/i18n'

export function HarnessDictation({value,onChange,locale,orgId,userId,disabled=false,maxLength=4000}:{value:string;onChange:(text:string)=>void;locale:string;orgId:string;userId:string;disabled?:boolean;maxLength?:number}){
 const t=useT(),[listening,setListening]=useState(false),[error,setError]=useState(false),[settings,setSettings]=useState(false),[words,setWords]=useState<string[]>([]),[newWord,setNewWord]=useState('')
 const current=useRef(value),run=useRef<{handle:Dictation|null;expected:string;active:boolean}|null>(null)
 current.current=value
 useEffect(()=>{setWords(readDictationVocabulary(orgId,userId));setNewWord('');setSettings(false)},[orgId,userId])
 const stop=()=>{const previous=run.current;run.current=null;if(previous){previous.active=false;previous.handle?.stop()}setListening(false)}
 useEffect(()=>{if(run.current&&(disabled||value!==run.current.expected))stop()},[value,disabled])
 useEffect(()=>()=>{const previous=run.current;run.current=null;if(previous){previous.active=false;previous.handle?.stop()}},[])
 if(!dictationAvailable())return null
 return <span className="hx-dictation">
  <button type="button" className="slk-attach-btn" disabled={disabled} aria-pressed={listening} aria-label={t(listening?'Stop voice input':'Voice input')} title={t(listening?'Stop voice input':'Voice input')} onClick={()=>{
   if(run.current){stop();return}
   setError(false)
   const base=current.current,session={handle:null as Dictation|null,expected:base,active:true};run.current=session;setListening(true)
   session.handle=startDictation(locale,text=>{
    if(run.current!==session||!session.active)return
    if(current.current!==session.expected){stop();return}
    const combined=base+(base&&!/\s$/.test(base)?' ':'')+text
    const next=combined.slice(0,maxLength)
    session.expected=next;current.current=next;onChange(next)
    if(combined.length>=maxLength)stop()
   },reason=>{if(run.current!==session||!session.active)return;session.active=false;run.current=null;setListening(false);if(reason){session.handle?.stop();setError(true)}},words)
   if(session.handle&&!session.active)session.handle.stop()
   if(!session.handle){session.active=false;run.current=null;setListening(false);setError(true)}
  }}><Icon name={listening?'mic-off':'mic'} size={17}/></button>
  <button type="button" className="hx-dictation-settings" aria-label={t('Voice vocabulary')} title={t('Voice vocabulary')} aria-expanded={settings} onClick={()=>setSettings(v=>!v)}><Icon name="settings" size={14}/></button>
  {settings&&<span className="hx-dictation-popover">
   <label>{t('Voice vocabulary')}</label>
   <span className="hx-dictation-description">{t('Names and phrases are saved for this account on this device.')}</span>
   <span className="hx-dictation-word-list">{words.map(word=><span key={word}>{word}<button type="button" aria-label={t('Remove {word}',{word})} onClick={()=>setWords(current=>writeDictationVocabulary(orgId,userId,current.filter(item=>item!==word)))}>×</button></span>)}</span>
   <form onSubmit={event=>{event.preventDefault();const clean=newWord.trim();if(clean&&!words.includes(clean)){setWords(current=>writeDictationVocabulary(orgId,userId,[...current,clean]))}setNewWord('')}}>
    <input aria-label={t('Add a word or phrase')} value={newWord} maxLength={80} onChange={event=>setNewWord(event.target.value)}/>
    <button type="submit" disabled={!newWord.trim()||words.length>=100}>{t('Add')}</button>
   </form>
   {words.length>0&&<button type="button" className="hx-dictation-clear" onClick={()=>setWords(writeDictationVocabulary(orgId,userId,[]))}>{t('Clear vocabulary')}</button>}
  </span>}
  {error&&<span className="hx-dictation-error" role="status">{t('Voice input unavailable. Check microphone access.')}</span>}
 </span>
}
