import {useCallback,useState} from 'react'
import type {JamState} from './jam'

// A socket can deliver its initial state before the conversation UI mounts.
// Keep only display state; never replay RTC offers, candidates, or call events.
export function useJamSnapshot(scope:string){
 const [snapshot,setSnapshot]=useState<{scope:string;states:Record<string,JamState>}>({scope,states:{}})
 const reset=useCallback(()=>setSnapshot({scope,states:{}}),[scope])
 const receive=useCallback((name:string,value:unknown)=>{
  if(name!=='jam_state'||!value||typeof value!=='object')return
  const state=value as JamState & {channel?:string}
  if(typeof state.channel!=='string'||!state.channel)return
  const channel=state.channel
  setSnapshot(previous=>{
   const states={...(previous.scope===scope?previous.states:{})}
   if(state.active)states[channel]=state
   else delete states[channel]
   return {scope,states}
  })
 },[scope])
 return {states:snapshot.scope===scope?snapshot.states:{},reset,receive}
}
