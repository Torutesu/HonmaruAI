import React,{useEffect,useRef,useState} from 'react'
import {Icon} from './Icon'
import {dictationAvailable,startDictation,type Dictation} from '../utils/dictation'
import {useT} from '../utils/i18n'

export function HarnessDictation({value,onChange,locale,disabled=false}:{value:string;onChange:(text:string)=>void;locale:string;disabled?:boolean}){
 const t=useT(),[listening,setListening]=useState(false),[error,setError]=useState(false)
 const current=useRef(value),run=useRef<{handle:Dictation|null;expected:string;active:boolean}|null>(null)
 current.current=value
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
    const next=base+(base&&!/\s$/.test(base)?' ':'')+text
    session.expected=next;current.current=next;onChange(next)
   },reason=>{if(run.current!==session||!session.active)return;session.active=false;run.current=null;setListening(false);if(reason)setError(true)})
   if(!session.handle){session.active=false;run.current=null;setListening(false);setError(true)}
  }}><Icon name={listening?'mic-off':'mic'} size={17}/></button>
  {error&&<span className="hx-dictation-error" role="status">{t('Voice input unavailable. Check microphone access.')}</span>}
 </span>
}
