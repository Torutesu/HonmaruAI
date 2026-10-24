import type {Run} from './harness'
import {getLocale} from './locale'
export function runDuration(run: Pick<Run,'status'|'startedAt'|'finishedAt'>): string | null {
 if(!['done','failed','declined','cancelled'].includes(run.status)||!run.finishedAt)return null
 const elapsed=Date.parse(run.finishedAt)-Date.parse(run.startedAt)
 if(!Number.isFinite(elapsed)||elapsed<0)return null
 let locale=getLocale()
 try{new Intl.NumberFormat(locale)}catch{locale='en'}
 const seconds=elapsed/1000
 const units: Array<[number,'hour'|'minute'|'second']> = seconds<60
  ? [[seconds,'second']]
  : seconds<3600 ? [[Math.floor(seconds/60),'minute'],[Math.floor(seconds%60),'second']]
  : [[Math.floor(seconds/3600),'hour'],[Math.floor(seconds%3600/60),'minute']]
 return units.map(([value,unit])=>new Intl.NumberFormat(locale,{style:'unit',unit,unitDisplay:'short',maximumFractionDigits:unit==='second'&&seconds<60?1:0}).format(value)).join(' ')
}
