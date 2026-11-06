import React,{useEffect,useRef,useState} from 'react'
import {Icon} from './Icon'
import {dictationAvailable,startDictation,type Dictation,type DictationCorrection,detectDictationCorrection,readDictationCorrections,readDictationVocabulary,writeDictationCorrections,writeDictationVocabulary} from '../utils/dictation'
import {useT} from '../utils/i18n'

type VocabularyState={vocabulary:string[];corrections:DictationCorrection[];revision:number}
export function HarnessDictation({value,onChange,locale,orgId,userId,loadVocabulary,saveVocabulary,disabled=false,maxLength=4000}:{value:string;onChange:(text:string)=>void;locale:string;orgId:string;userId:string;loadVocabulary?:()=>Promise<VocabularyState>;saveVocabulary?:(words:string[],corrections:DictationCorrection[],expectedRevision:number)=>Promise<VocabularyState>;disabled?:boolean;maxLength?:number}){
 const t=useT(),[listening,setListening]=useState(false),[error,setError]=useState(false),[settings,setSettings]=useState(false),[words,setWords]=useState<string[]>([]),[corrections,setCorrections]=useState<DictationCorrection[]>([]),[newWord,setNewWord]=useState(''),[saving,setSaving]=useState(false),[loading,setLoading]=useState(Boolean(loadVocabulary))
 const canDictate=dictationAvailable()
 const revision=useRef(0)
 const current=useRef(value),run=useRef<{handle:Dictation|null;expected:string;prefix:string;active:boolean}|null>(null)
 const lastTranscript=useRef<{expected:string;prefix:string;at:number}|null>(null)
 current.current=value
 useEffect(()=>{let live=true;revision.current=0;setWords(readDictationVocabulary(orgId,userId));setCorrections(readDictationCorrections(orgId,userId));setNewWord('');setSettings(false);setError(false);setLoading(Boolean(canDictate&&loadVocabulary));if(canDictate&&loadVocabulary)void loadVocabulary().then(remote=>{if(!live)return;revision.current=remote.revision;setWords(writeDictationVocabulary(orgId,userId,remote.vocabulary));setCorrections(writeDictationCorrections(orgId,userId,remote.corrections));setLoading(false)}).catch(()=>{if(live){setError(true);setLoading(false)}});return()=>{live=false}},[orgId,userId,loadVocabulary,canDictate])
 const saveSettings=async(nextWords:string[],nextCorrections:DictationCorrection[])=>{const cleanWords=writeDictationVocabulary(orgId,userId,nextWords),cleanCorrections=writeDictationCorrections(orgId,userId,nextCorrections);setWords(cleanWords);setCorrections(cleanCorrections);setError(false);if(!saveVocabulary)return;setSaving(true);try{const saved=await saveVocabulary(cleanWords,cleanCorrections,revision.current);revision.current=saved.revision;setWords(writeDictationVocabulary(orgId,userId,saved.vocabulary));setCorrections(writeDictationCorrections(orgId,userId,saved.corrections))}catch{setError(true)}finally{setSaving(false)}}
 const saveWords=async(next:string[])=>saveSettings(next,corrections)
 const learnCorrection=(correction:DictationCorrection|null)=>{if(!correction||corrections.some(item=>item.from.toLocaleLowerCase()===correction.from.toLocaleLowerCase()))return;lastTranscript.current=null;void saveSettings(words,[...corrections,correction])}
 const reloadWords=async()=>{if(!loadVocabulary)return;setSaving(true);try{const remote=await loadVocabulary();revision.current=remote.revision;setWords(writeDictationVocabulary(orgId,userId,remote.vocabulary));setCorrections(writeDictationCorrections(orgId,userId,remote.corrections));setError(false)}catch{setError(true)}finally{setSaving(false)}}
 useEffect(()=>{if(typeof window==='undefined')return;const changed=(event:Event)=>{const detail=(event as CustomEvent<{orgId?:string;revision?:number}>).detail;if(detail?.orgId!==orgId||!Number.isSafeInteger(detail.revision)||Number(detail.revision)<=revision.current||!loadVocabulary)return;void loadVocabulary().then(remote=>{if(remote.revision>=revision.current){revision.current=remote.revision;setWords(writeDictationVocabulary(orgId,userId,remote.vocabulary));setCorrections(writeDictationCorrections(orgId,userId,remote.corrections))}}).catch(()=>setError(true))};window.addEventListener('honmaru:dictation-vocabulary-changed',changed);return()=>window.removeEventListener('honmaru:dictation-vocabulary-changed',changed)},[orgId,userId,loadVocabulary])
 const stop=()=>{const previous=run.current;run.current=null;if(previous){previous.active=false;if(previous.expected!==previous.prefix)lastTranscript.current={expected:previous.expected,prefix:previous.prefix,at:Date.now()};previous.handle?.stop()}setListening(false)}
 useEffect(()=>{const session=run.current;if(!session){const previous=lastTranscript.current;if(previous&&Date.now()-previous.at<5*60_000&&value!==previous.expected){const correction=detectDictationCorrection(previous.expected,value,previous.prefix,locale);lastTranscript.current=null;learnCorrection(correction)}else if(previous&&(!value.startsWith(previous.prefix)||Date.now()-previous.at>=5*60_000))lastTranscript.current=null;return}if(disabled){stop();return}if(value!==session.expected){const correction=detectDictationCorrection(session.expected,value,session.prefix,locale);lastTranscript.current={expected:session.expected,prefix:session.prefix,at:Date.now()};learnCorrection(correction);stop()}},[value,disabled,corrections,words,locale])
 useEffect(()=>()=>{const previous=run.current;run.current=null;if(previous){previous.active=false;previous.handle?.stop()}},[])
 if(!canDictate)return null
 return <span className="hx-dictation">
  <button type="button" className="slk-attach-btn" disabled={disabled} aria-pressed={listening} aria-label={t(listening?'Stop voice input':'Voice input')} title={t(listening?'Stop voice input':'Voice input')} onClick={()=>{
   if(run.current){stop();return}
   setError(false)
   const base=current.current,prefix=base+(base&&!/\s$/.test(base)?' ':''),session={handle:null as Dictation|null,expected:base,prefix,active:true};lastTranscript.current=null;run.current=session;setListening(true)
   session.handle=startDictation(locale,text=>{
    if(run.current!==session||!session.active)return
    if(current.current!==session.expected){stop();return}
    const combined=prefix+text
    const next=combined.slice(0,maxLength)
    session.expected=next;current.current=next;onChange(next)
    if(combined.length>=maxLength)stop()
   },reason=>{if(run.current!==session||!session.active)return;session.active=false;if(session.expected!==session.prefix)lastTranscript.current={expected:session.expected,prefix:session.prefix,at:Date.now()};run.current=null;setListening(false);if(reason){session.handle?.stop();setError(true)}},words,corrections)
   if(session.handle&&!session.active)session.handle.stop()
   if(!session.handle){session.active=false;run.current=null;setListening(false);setError(true)}
  }}><Icon name={listening?'mic-off':'mic'} size={17}/></button>
  <button type="button" className="hx-dictation-settings" aria-label={t('Voice vocabulary')} title={t('Voice vocabulary')} aria-expanded={settings} onClick={()=>setSettings(v=>!v)}><Icon name="settings" size={14}/></button>
  {settings&&<span className="hx-dictation-popover">
   <label>{t('Voice vocabulary')}</label>
   <span className="hx-dictation-description">{t('Names and phrases sync for your account across devices in this workspace.')}</span>
   <span className="hx-dictation-word-list">{words.map(word=><span key={word}>{word}<button type="button" disabled={saving||loading} aria-label={t('Remove {word}',{word})} onClick={()=>void saveWords(words.filter(item=>item!==word))}>×</button></span>)}</span>
   {corrections.length>0&&<><label>{t('Learned corrections')}</label><span className="hx-dictation-word-list">{corrections.map(item=><span key={item.from}>{item.from} → {item.to}<button type="button" disabled={saving||loading} aria-label={t('Remove correction {word}',{word:item.to})} onClick={()=>void saveSettings(words,corrections.filter(correction=>correction.from!==item.from))}>×</button></span>)}</span></>}
   <form onSubmit={event=>{event.preventDefault();const clean=newWord.trim();if(clean&&!words.includes(clean))void saveWords([...words,clean]);setNewWord('')}}>
    <input aria-label={t('Add a word or phrase')} disabled={saving||loading} value={newWord} maxLength={80} onChange={event=>setNewWord(event.target.value)}/>
    <button type="submit" disabled={saving||loading||!newWord.trim()||words.length>=100}>{t('Add')}</button>
   </form>
   {words.length>0&&<button type="button" className="hx-dictation-clear" disabled={saving||loading} onClick={()=>void saveWords([])}>{t('Clear vocabulary')}</button>}
   {error&&<span role="status">{t('Voice vocabulary could not sync. Your local copy is kept.')}{loadVocabulary&&<button type="button" onClick={()=>void reloadWords()} disabled={saving}>{t('Reload')}</button>}</span>}
  </span>}
  {error&&<span className="hx-dictation-error" role="status">{t('Voice input unavailable. Check microphone access.')}</span>}
 </span>
}
