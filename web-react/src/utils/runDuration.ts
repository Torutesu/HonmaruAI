import type {Run} from './harness'
import {getLocale} from './locale'
function localeOrEnglish(locale:string){
 try{new Intl.NumberFormat(locale);return locale}catch{return 'en'}
}
function formatElapsed(elapsed:number,locale:string){
 const safeLocale=localeOrEnglish(locale)
 const seconds=elapsed/1000
 const units:Array<[number,'hour'|'minute'|'second']>=seconds<60
  ? [[seconds,'second']]
  : seconds<3600 ? [[Math.floor(seconds/60),'minute'],[Math.floor(seconds%60),'second']]
  : [[Math.floor(seconds/3600),'hour'],[Math.floor(seconds%3600/60),'minute']]
 const value=units.map(([amount,unit])=>new Intl.NumberFormat(safeLocale,{style:'unit',unit,unitDisplay:'short',maximumFractionDigits:unit==='second'&&seconds<60?1:0}).format(amount)).join(' ')
 return safeLocale.toLowerCase().startsWith('ja')?value.replace(/\s+/g,''):value
}

export function formatElapsedDuration(startedAt:string,finishedAt:string|null,locale=getLocale(),now=Date.now()):string|null{
 const start=Date.parse(startedAt),end=finishedAt===null?now:Date.parse(finishedAt)
 if(!Number.isFinite(start)||!Number.isFinite(end)||end<start)return null
 return formatElapsed(end-start,locale)
}

export function runDuration(run: Pick<Run,'status'|'startedAt'|'finishedAt'>): string | null {
 if(!['done','failed','declined','cancelled'].includes(run.status)||!run.finishedAt)return null
 const elapsed=Date.parse(run.finishedAt)-Date.parse(run.startedAt)
 if(!Number.isFinite(elapsed)||elapsed<0)return null
 return formatElapsed(elapsed,getLocale())
}
