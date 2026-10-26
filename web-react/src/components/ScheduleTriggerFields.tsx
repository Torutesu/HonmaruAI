import React from 'react'
import {useT} from '../utils/i18n'
import type {Trigger} from '../utils/harness'

const MIN_INTERVAL_MS = 10 * 60 * 1000
const MAX_INTERVAL_MINUTES = 10 * 365 * 24 * 60

function localDateTime(value?: string) {
  if (!value || !Number.isFinite(Date.parse(value))) return ''
  const date = new Date(value)
  const part = (number: number) => String(number).padStart(2, '0')
  return `${date.getFullYear()}-${part(date.getMonth() + 1)}-${part(date.getDate())}T${part(date.getHours())}:${part(date.getMinutes())}`
}

function defaultAt() {
  const date = new Date(Date.now() + 60 * 60 * 1000)
  date.setSeconds(0, 0)
  return date.toISOString()
}

export function ScheduleTriggerFields({trigger,onChange,legacyDefault='daily'}:{trigger:Trigger;onChange:(trigger:Trigger)=>void;legacyDefault?:string}) {
  const t = useT()
  const tz = trigger.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  const kind = trigger.kind || 'cadence'
  const cadence = trigger.cadence || legacyDefault
  const changeKind = (next: string) => {
    if (next === 'every') onChange({type:'schedule',kind:'every',everyMs:60*60*1000})
    else if (next === 'cron') onChange({type:'schedule',kind:'cron',expr:'0 9 * * 1-5',timezone:tz})
    else if (next === 'at') onChange({type:'schedule',kind:'at',at:defaultAt()})
    else onChange({type:'schedule',cadence:'daily',hour:9,minute:0,timezone:tz})
  }
  return <span className="hx-inline">
    <label>{t('Schedule type')} <select value={kind} onChange={event=>changeKind(event.target.value)} aria-label={t('Schedule type')}>
      <option value="cadence">{t('Calendar schedule')}</option>
      <option value="every">{t('Every interval')}</option>
      <option value="cron">{t('Cron expression')}</option>
      <option value="at">{t('One time')}</option>
    </select></label>
    {kind==='cadence'&&<>
      <label>{t('Cadence')} <select value={cadence} onChange={event=>onChange({type:'schedule',cadence:event.target.value,hour:trigger.hour??9,minute:trigger.minute??0,timezone:tz,...(event.target.value==='weekly'?{weekday:trigger.weekday??1}:{}),...(event.target.value==='monthly'?{monthday:trigger.monthday??1}:{})})} aria-label={t('Cadence')}>
        <option value="daily">{t('daily')}</option><option value="weekdays">{t('weekdays')}</option><option value="weekly">{t('weekly')}</option><option value="monthly">{t('monthly')}</option>
      </select></label>
      {cadence==='weekly'&&<label>{t('Weekday')} <select value={trigger.weekday??1} onChange={event=>onChange({...trigger,weekday:Number(event.target.value)})} aria-label={t('Weekday')}>
        {['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'].map((day,index)=><option key={day} value={index}>{t(day)}</option>)}
      </select></label>}
      {cadence==='monthly'&&<label>{t('Day of month')} <select value={trigger.monthday??1} onChange={event=>onChange({...trigger,monthday:Number(event.target.value)})} aria-label={t('Day of month')}>
        {Array.from({length:31},(_,index)=><option key={index+1} value={index+1}>{t('Day {day}',{day:index+1})}</option>)}
      </select></label>}
      <label>{t('Time')} <input type="time" className="hx-cell-input" value={`${String(trigger.hour??9).padStart(2,'0')}:${String(trigger.minute??0).padStart(2,'0')}`} onChange={event=>{if(!event.target.value)return;const [hour,minute]=event.target.value.split(':').map(Number);onChange({...trigger,hour,minute})}} aria-label={t('Time')}/></label>
      <label>{t('Time zone')} <input className="hx-cell-input" value={tz} placeholder="Asia/Tokyo" onChange={event=>onChange({...trigger,timezone:event.target.value})} aria-label={t('Time zone')}/></label>
      {cadence==='monthly'&&<span className="row-sub">{t('If the date does not exist, runs on the last day of the month.')}</span>}
    </>}
    {kind==='every'&&<label>{t('Interval in minutes')} <input className="hx-cell-input" type="number" min={MIN_INTERVAL_MS/60000} max={MAX_INTERVAL_MINUTES} step={1} value={Math.round((trigger.everyMs??60*60*1000)/60000)} onChange={event=>onChange({type:'schedule',kind:'every',everyMs:Number(event.target.value)*60000})} aria-label={t('Interval in minutes')}/></label>}
    {kind==='cron'&&<>
      <label>{t('Cron expression')} <input className="hx-cell-input" value={trigger.expr||''} placeholder="0 9 * * 1-5" onChange={event=>onChange({...trigger,expr:event.target.value})} aria-label={t('Cron expression')}/></label>
      <label>{t('Time zone')} <input className="hx-cell-input" value={tz} placeholder="Asia/Tokyo" onChange={event=>onChange({...trigger,timezone:event.target.value})} aria-label={t('Time zone')}/></label>
      <span className="row-sub">{t('Five fields: minute hour day month weekday. Minimum interval is 10 minutes.')}</span>
    </>}
    {kind==='at'&&<><label>{t('Run at')} <input type="datetime-local" className="hx-cell-input" value={localDateTime(trigger.at)} onChange={event=>onChange({type:'schedule',kind:'at',at:event.target.value?new Date(event.target.value).toISOString():''})} aria-label={t('Run at')}/></label><span className="row-sub">{t('Uses your device local time zone.')}</span></>}
  </span>
}
