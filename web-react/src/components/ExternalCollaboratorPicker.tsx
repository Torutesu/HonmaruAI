import React, { useEffect, useState } from 'react'
import { useT } from '../utils/i18n'
import { searchExternalCollaborators, type ExternalCollaborator } from '../utils/externalCollaborators'

export function ExternalCollaboratorPicker({ httpBase, sessionToken, orgId, resourceType, resourceId, value, onChange, disabled = false, searchPeople }:{
  httpBase:string; sessionToken:string; orgId:string; resourceType:'thread'|'app'|'file'; resourceId:string
  value:ExternalCollaborator|null; onChange:(person:ExternalCollaborator|null)=>void; disabled?:boolean
  searchPeople?:(query:string,signal?:AbortSignal)=>Promise<ExternalCollaborator[]>
}) {
  const t=useT(), [query,setQuery]=useState(''), [people,setPeople]=useState<ExternalCollaborator[]>([]), [loading,setLoading]=useState(false), [error,setError]=useState('')
  useEffect(()=>{
    const clean=query.trim()
    if(clean.length<3){setPeople([]);setError('');setLoading(false);return}
    const controller=new AbortController()
    const timer=setTimeout(()=>{
      setLoading(true);setError('')
      void (searchPeople?searchPeople(clean,controller.signal):searchExternalCollaborators(httpBase,sessionToken,{orgId,resourceType,resourceId,query:clean},controller.signal))
        .then(setPeople).catch(reason=>{if(!controller.signal.aborted){setPeople([]);setError(reason instanceof Error?reason.message:t('Could not search collaborators.'))}})
        .finally(()=>{if(!controller.signal.aborted)setLoading(false)})
    },250)
    return()=>{clearTimeout(timer);controller.abort()}
  },[httpBase,sessionToken,orgId,resourceType,resourceId,query,searchPeople])
  return <div className="hx-external-collaborator-picker">
    <label>{t('Find someone by name or email')}
      <input type="search" autoComplete="off" value={value?`${value.name}${value.login?` · @${value.login}`:''}`:query} disabled={disabled}
        placeholder={t('Type at least 3 characters')} onChange={event=>{onChange(null);setQuery(event.target.value)}} onFocus={()=>{if(value){onChange(null);setQuery('')}}}/>
    </label>
    {query.trim().length>0&&query.trim().length<3&&<small>{t('Type at least 3 characters')}</small>}
    {loading&&<small role="status">{t('Searching…')}</small>}
    {error&&<small role="alert">{error}</small>}
    {!loading&&!error&&query.trim().length>=3&&<ul role="listbox" aria-label={t('Matching people')}>
      {people.map(person=><li key={person.ref}><button type="button" role="option" aria-selected={value?.ref===person.ref} disabled={disabled} onClick={()=>{onChange(person);setQuery('');setPeople([])}}>
        <span>{person.name}</span>{person.login&&<small>@{person.login}</small>}
      </button></li>)}
      {people.length===0&&<li><small>{t('No matching people found.')}</small></li>}
    </ul>}
  </div>
}
