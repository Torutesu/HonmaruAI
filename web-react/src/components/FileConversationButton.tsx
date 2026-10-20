import React,{useEffect,useRef,useState} from 'react'
import {openFileConversation} from '../utils/fileConversation'
import {Icon} from './Icon'
import './FileConversationButton.css'

export function FileConversationButton({fileId,onOpen}:{fileId:string;onOpen?:()=>void}){
 const [busy,setBusy]=useState(false),[error,setError]=useState('')
 const epoch=useRef(0)
 useEffect(()=>{epoch.current++;setBusy(false);setError('');return()=>{epoch.current++}},[fileId])
 const open=async()=>{
  if(busy)return
  const generation=epoch.current;setBusy(true);setError('')
  try{const hash=await openFileConversation(fileId);if(epoch.current===generation){onOpen?.();location.hash=hash}}
  catch(error){if(epoch.current===generation)setError(error instanceof Error?error.message:'会話を開けませんでした。')}
  finally{if(epoch.current===generation)setBusy(false)}
 }
 return <span className="file-conversation-control"><button type="button" disabled={busy} onClick={()=>void open()}><Icon name="message" size={16}/>{busy?'会話を開いています…':'ファイルの会話'}</button>{error&&<span role="alert">{error}</span>}</span>
}
