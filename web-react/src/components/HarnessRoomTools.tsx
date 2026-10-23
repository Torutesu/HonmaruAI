import {RoomGuidelinesDialog} from './RoomGuidelinesDialog'
import React,{useEffect,useRef,useState} from 'react'
import {Icon} from './Icon'
import {RowMenu} from './RowMenu'
import {ThreadSearch} from './ThreadSearch'
import type {ChannelMessage} from '../types/card'

type Props={api:{httpBase:string;orgId:string;sessionToken:string};channel:string;shortcut:boolean;pinned:boolean;muted:boolean;onSelect:(message:ChannelMessage,signal:AbortSignal)=>Promise<void>;onCopy:()=>void;onPin:()=>void;onSettings:()=>void;onMute:()=>void}
export function HarnessRoomTools(props:Props){
 const [guidelines,setGuidelines]=useState(false)
 const [search,setSearch]=useState(false),[menu,setMenu]=useState<{x:number;y:number;anchor:HTMLElement}|null>(null)
 const trigger=useRef<HTMLButtonElement>(null)
 const [focusKey,setFocusKey]=useState(0)
 const openSearch=()=>{setSearch(true);setFocusKey(key=>key+1)}
 useEffect(()=>{
  if(!props.shortcut)return
  const onKey=(event:KeyboardEvent)=>{if(!event.defaultPrevented&&!event.isComposing&&(event.metaKey||event.ctrlKey)&&!event.altKey&&event.key.toLowerCase()==='f'){event.preventDefault();setMenu(null);openSearch()}}
  window.addEventListener('keydown',onKey);return()=>window.removeEventListener('keydown',onKey)
 },[props.shortcut])
 const closeSearch=()=>{setSearch(false);trigger.current?.focus()}
 return <>
  <button ref={trigger} type="button" className="slk-more" aria-label="その他のルーム操作" aria-haspopup="menu" aria-expanded={!!menu} onClick={event=>{const rect=event.currentTarget.getBoundingClientRect();setMenu({x:rect.right,y:rect.bottom,anchor:event.currentTarget})}}><Icon name="more" size={16}/></button>
  {menu&&<RowMenu at={menu} anchor={menu.anchor} label="その他のルーム操作" onClose={()=>setMenu(null)} entries={[
   {kind:'item',label:'ルーム内を検索',icon:'search',hint:'⌘F',onSelect:openSearch},
   {kind:'item',label:'リンクをコピー',icon:'link',onSelect:props.onCopy},
   {kind:'item',label:props.pinned?'ホームへの固定を解除':'ホームに固定',icon:'pin',onSelect:props.onPin},
   {kind:'sep'},
   {kind:'item',label:'ガイドライン',icon:'book',onSelect:()=>setGuidelines(true)},
   {kind:'item',label:'設定',icon:'settings',onSelect:props.onSettings},
   {kind:'item',label:props.muted?'ミュートを解除':'ミュート',icon:props.muted?'bell':'bell-off',onSelect:props.onMute},
  ]}/>}
  {guidelines&&<RoomGuidelinesDialog api={props.api} channel={props.channel} onClose={()=>setGuidelines(false)}/>}
  {search&&<ThreadSearch focusKey={focusKey} api={props.api} channel={props.channel} onSelect={props.onSelect} onClose={closeSearch}/>}
 </>
}
