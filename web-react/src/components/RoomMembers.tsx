import React,{useCallback,useEffect,useRef,useState} from 'react'
import {RoomMembersDialog,type RoomMemberRow} from './RoomMembersDialog'
interface RoomDetails {
 channel:{managed?:boolean;version?:number;canInvite?:boolean}
 members:{people:Array<{ref:string;name:string;avatarUrl?:string;roomRole:'admin'|'member';canChangeRole?:boolean;canRemove?:boolean;you?:boolean}>;agents:Array<{id:string;name:string;avatarUrl?:string;roomRole:'admin'|'member';canChangeRole?:boolean;canRemove?:boolean}>}
}
export function RoomMembers({api,view,onClose,onAdd,onProfile,onChanged}:{
 api:{httpBase:string;orgId:string;sessionToken:string};view:string;onClose:()=>void;onAdd:()=>void
 onProfile:(member:RoomMemberRow)=>void;onChanged:()=>void
}){
 const[data,setData]=useState<RoomDetails|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(true)
 const scope=useRef(0),reads=useRef(0)
 const load=useCallback(async()=>{
  const generation=scope.current,read=++reads.current
  try{
   const response=await fetch(`${api.httpBase}/channels/details?${new URLSearchParams({orgId:api.orgId,channel:view})}`,{headers:{'x-session-token':api.sessionToken}})
   const result=await response.json();if(!response.ok)throw Error(result.message||'The details did not load. Try again.')
   if(generation!==scope.current||read!==reads.current)return
   if(!result.channel?.managed)throw Error('This room does not support room roles.')
   setData(result);setError('');setLoading(false)
  }catch(e){if(generation===scope.current&&read===reads.current){setError(e instanceof Error?e.message:String(e));setLoading(false)}}
 },[api.httpBase,api.orgId,api.sessionToken,view])
 useEffect(()=>{scope.current++;setData(null);setLoading(true);setError('');void load();return()=>{scope.current++;reads.current++}},[load])
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
 return <RoomMembersDialog members={members} loading={loading} error={error} onReload={()=>void load()} onClose={onClose} onAdd={data?.channel.canInvite?onAdd:undefined} onProfile={onProfile} onRole={(member,role)=>mutate(member,role)} onRemove={member=>mutate(member)}/>
}
