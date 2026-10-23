import React,{useCallback,useEffect,useRef,useState} from 'react'
import {RoomMembersDialog,type RoomMemberRow} from './RoomMembersDialog'
import {RoomMemberPicker,type RoomCandidate} from './RoomMemberPicker'
interface RoomDetails {
 addableAgents?:Array<{id:string;name:string;avatarUrl?:string|null}>
 channel:{managed?:boolean;version?:number;canInvite?:boolean}
 members:{people:Array<{ref:string;name:string;avatarUrl?:string;roomRole:'admin'|'member';canChangeRole?:boolean;canRemove?:boolean;you?:boolean}>;agents:Array<{id:string;name:string;avatarUrl?:string;roomRole:'admin'|'member';canChangeRole?:boolean;canRemove?:boolean}>}
}
export function RoomMembers({api,view,onClose,onInvite,onProfile,onChanged,people=[]}:{
 api:{httpBase:string;orgId:string;sessionToken:string};view:string;onClose:()=>void;onInvite:()=>void;people?:Array<{ref:string;name:string;avatarUrl?:string|null}>
 onProfile:(member:RoomMemberRow)=>void;onChanged:()=>void
}){
 const[data,setData]=useState<RoomDetails|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(true)
 const [adding,setAdding]=useState(false)
 const addingPending=useRef(false)
 const scope=useRef(0),reads=useRef(0)
 const load=useCallback(async()=>{
  const generation=scope.current,read=++reads.current
  try{
   const response=await fetch(`${api.httpBase}/channels/details?${new URLSearchParams({orgId:api.orgId,channel:view})}`,{headers:{'x-session-token':api.sessionToken}})
   const result=await response.json();if(!response.ok)throw Error(result.message||'The details did not load. Try again.')
   if(generation!==scope.current||read!==reads.current)return
   if(!result.channel?.managed)throw Error('This room does not support room roles.')
   setData(result);setError('');setLoading(false);return result as RoomDetails
  }catch(e){if(generation===scope.current&&read===reads.current){setError(e instanceof Error?e.message:String(e));setLoading(false)}}
 },[api.httpBase,api.orgId,api.sessionToken,view])
 useEffect(()=>{scope.current++;setAdding(false);setData(null);setLoading(true);setError('');void load();return()=>{scope.current++;reads.current++}},[load])
 const mutate=async(member:RoomMemberRow,role?:'admin'|'member')=>{
  const generation=scope.current,version=data?.channel.version
  if(!Number.isSafeInteger(version))throw Error('Reload before saving.')
  const path=role?'room-role':member.kind==='person'?'members':'channel-agents'
  const response=await fetch(`${api.httpBase}/channels/${path}`,{method:role?'PUT':'DELETE',headers:{'content-type':'application/json','x-session-token':api.sessionToken},body:JSON.stringify({orgId:api.orgId,channel:view,version,...(role?{kind:member.kind,id:member.id,role}:member.kind==='person'?{ref:member.id}:{agentId:member.id})})})
  const result=await response.json()
  if(generation!==scope.current)return
  if(!response.ok){await load();throw Error(result.message||'That did not save.')}
  onChanged()
  if(!role&&member.kind==='person'&&data?.members.people.find(p=>p.ref===member.id)?.you){onClose();return}
  await load()
 }
 const members:RoomMemberRow[]=data?[...data.members.agents.map(a=>({...a,kind:'agent' as const,role:a.roomRole})),...data.members.people.map(p=>({...p,id:p.ref,kind:'person' as const,role:p.roomRole}))]:[]
 const candidates:RoomCandidate[]=data?[
  ...people.filter(person=>!data.members.people.some(member=>member.ref===person.ref)).map(person=>({...person,id:person.ref,kind:'person' as const})),
  ...(data.addableAgents||[]).map(agent=>({...agent,kind:'agent' as const})),
 ]:[]
 const add=async(selected:RoomCandidate[])=>{
  if(addingPending.current)return
  if(!data?.channel.canInvite||error)throw Error('Reload before saving.')
  addingPending.current=true
  const generation=scope.current
  try{
   const allowed=new Set(candidates.map(row=>`${row.kind}:${row.id}`))
   if(selected.some(row=>!allowed.has(`${row.kind}:${row.id}`)))throw Error('Reload before saving.')
   const humans=selected.filter(row=>row.kind==='person').map(row=>row.id)
   const steps=[...(humans.length?[{path:'members',body:{refs:humans}}]:[]),...selected.filter(row=>row.kind==='agent').map(row=>({path:'channel-agents',body:{agentId:row.id}}))]
   for(const step of steps){
    if(generation!==scope.current)return
    const response=await fetch(`${api.httpBase}/channels/${step.path}`,{method:'POST',headers:{'content-type':'application/json','x-session-token':api.sessionToken},body:JSON.stringify({orgId:api.orgId,channel:view,...step.body})})
    const result=await response.json()
    if(generation!==scope.current)return
    if(!response.ok)throw Error(result.message||'That did not save.')
    onChanged()
   }
   if(generation===scope.current){const refreshed=await load();if(refreshed&&generation===scope.current)setAdding(false)}
  }catch(e){
   if(generation!==scope.current)return
   // A previous step may have committed. Refresh candidates before retrying
   // so successfully added people/agents are not submitted a second time.
   await load();throw e
  }finally{addingPending.current=false}
 }
 if(adding)return <RoomMemberPicker candidates={candidates} error={error||(!data?.channel.canInvite?'Reload before saving.':'')} onReload={()=>void load()} onAdd={add} onClose={()=>setAdding(false)} onInvite={()=>{onClose();onInvite()}}/>
 return <RoomMembersDialog members={members} loading={loading} error={error} onReload={()=>void load()} onClose={onClose} onAdd={data?.channel.canInvite?()=>setAdding(true):undefined} onProfile={onProfile} onRole={(member,role)=>mutate(member,role)} onRemove={member=>mutate(member)}/>
}
