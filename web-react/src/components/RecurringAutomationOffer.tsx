import {useState} from 'react'
import {useT} from '../utils/i18n'
import {Icon} from './Icon'
import './RecurringAutomationOffer.css'

export function RecurringAutomationOffer({api,offerId,onOpenWorkflow}:{api:{httpBase:string;orgId:string;sessionToken:string};offerId:string;onOpenWorkflow?:(id?:string)=>void}){
 const t=useT(),[busy,setBusy]=useState(false),[state,setState]=useState<'offered'|'declined'|'created'>('offered'),[error,setError]=useState('')
 const answer=async(action:'accept'|'decline')=>{
  setBusy(true);setError('')
  const response=await fetch(`${api.httpBase}/workflows/offers/${encodeURIComponent(offerId)}/${action}`,{method:'POST',headers:{'content-type':'application/json','x-session-token':api.sessionToken},body:JSON.stringify({orgId:api.orgId,timezone:Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC'})}).catch(()=>null)
  const data=response?.ok?await response.json().catch(()=>null):null
  setBusy(false)
  if(!response?.ok||!data){setError(data?.message||t('That did not save. Try again.'));return}
  const next=data.offer?.state
  if(next==='declined'){setState('declined');return}
  if(next==='created'&&data.workflow?.id){setState('created');onOpenWorkflow?.(data.workflow.id);return}
  setError(t('The Automation could not be opened.'))
 }
 if(state==='declined')return null
 return <div className="hx-recurring-offer" data-state={state}>
  {state==='offered'?<><span><Icon name="zap" size={14}/>{t('Set up an Automation for this recurring work?')}</span><button type="button" disabled={busy} onClick={()=>void answer('accept')}>{busy?t('Setting up…'):t('Set up')}</button><button type="button" className="quiet" disabled={busy} onClick={()=>void answer('decline')}>{t('Not now')}</button></>:<span role="status"><Icon name="check" size={14}/>{t('Automation is active')}</span>}
  {error&&<small role="alert">{error}</small>}
 </div>
}
