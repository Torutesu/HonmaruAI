import type {Run} from './harness'

export type RunDay = {date:Date|null;runs:Run[]}

function dayKey(date:Date){return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`}

function timestamp(value:string){
 const parsed=new Date(value).getTime()
 return Number.isFinite(parsed)?parsed:Number.NEGATIVE_INFINITY
}

export function groupRunsByStartDay(runs:Run[]):Array<[string,RunDay]>{
 const days=new Map<string,RunDay>()
 for(const run of runs){
  const date=new Date(run.startedAt),valid=Number.isFinite(date.getTime()),key=valid?dayKey(date):`invalid:${run.startedAt}`
  const group=days.get(key)||{date:valid?date:null,runs:[]}
  group.runs.push(run)
  days.set(key,group)
 }
 return [...days.entries()]
  .sort(([,a],[,b])=>(b.date?.getTime()??Number.NEGATIVE_INFINITY)-(a.date?.getTime()??Number.NEGATIVE_INFINITY))
  .map(([key,group]):[string,RunDay]=>[key,{...group,runs:group.runs.sort((a,b)=>timestamp(b.startedAt)-timestamp(a.startedAt))}])
}

export function runDayLabel(date:Date|null,locale:string,t:(key:string)=>string){
 if(!date)return t('Date unavailable')
 const today=new Date()
 if(dayKey(date)===dayKey(today))return t('Today')
 const yesterday=new Date(today)
 yesterday.setDate(yesterday.getDate()-1)
 if(dayKey(date)===dayKey(yesterday))return t('Yesterday')
 return date.toLocaleDateString(locale,{year:'numeric',month:'long',day:'numeric'})
}

export function runTimestampLabel(startedAt:string,locale:string,unavailable:string){
 const date=new Date(startedAt)
 return Number.isFinite(date.getTime())?date.toLocaleString(locale):unavailable
}
