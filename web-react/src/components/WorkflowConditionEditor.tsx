import React,{useState} from 'react'
import {useT} from '../utils/i18n'
import type {WorkflowCondition,ConditionScalar,Table} from '../utils/harness'
export const blankCondition=():WorkflowCondition=>({path:['input','value'],op:'eq',value:''})
const operators={eq:"Equals",neq:"Does not equal",gt:"Greater than",gte:"At least",lt:"Less than",lte:"At most",contains:"Contains text",in:"One of the candidates",exists:"Field exists"}
const scalarType=(value:ConditionScalar)=>value===null?'null':typeof value
function ScalarEditor({value,onChange,kind, label}:{value:ConditionScalar;onChange:(value:ConditionScalar)=>void;kind?:string;label:string}) {
 const t=useT()
 const type=kind||scalarType(value)
 return <span className="hx-condition-value">
  {!kind&&<select aria-label={t('Type of {label}',{label})} value={type} onChange={event=>onChange(event.target.value==='number'?0:event.target.value==='boolean'?true:event.target.value==='null'?null:'')}><option value="string">{t("Text")}</option><option value="number">{t("Number")}</option><option value="boolean">{t("Boolean")}</option><option value="null">{t("Null")}</option></select>}
  {type==='boolean'?<select aria-label={label} value={String(value)} onChange={event=>onChange(event.target.value==='true')}><option value="true">{t("Yes")}</option><option value="false">{t("No")}</option></select>:type==='null'?<span>{t("Null value")}</span>:<input className="hx-cell-input" aria-label={label} type={type==='number'?'number':'text'} step={type==='number'?'any':undefined} maxLength={4000} required={type==='number'} value={value==null?'':String(value)} onChange={event=>{const raw=event.target.value;onChange(type==='number'&&raw!==''&&Number.isFinite(Number(raw))?Number(raw):raw)}}/>}
 </span>
}
function size(condition:WorkflowCondition,depth=0):{nodes:number;depth:number} {
 const children='all'in condition?condition.all:'any'in condition?condition.any:'not'in condition?[condition.not]:[]
 return children.reduce((total,child)=>{const childSize=size(child,depth+1);return {nodes:total.nodes+childSize.nodes,depth:Math.max(total.depth,childSize.depth)}},{nodes:1,depth})
}
export function WorkflowConditionEditor({value,onChange,columns=[]}:{value:WorkflowCondition;onChange:(value:WorkflowCondition)=>void;columns?:Table["columns"]}) {
 const t=useT()
 const [error,setError]=useState('')
 const change=(next:WorkflowCondition)=>{const count=size(next);if(count.nodes>64||count.depth>8){setError(t("Conditions support up to 64 nodes and 8 nesting levels."));return}setError('');onChange(next)}
 return <div className="hx-condition-editor"><ConditionNode value={value} onChange={change} columns={columns}/>{error&&<p role="alert">{error}</p>}</div>
}
function ConditionNode({value,onChange,columns=[]}:{value:WorkflowCondition;onChange:(value:WorkflowCondition)=>void;columns?:Table["columns"]}) {
 const t=useT()
 const mode='all'in value?'all':'any'in value?'any':'not'in value?'not':'match'
 const children='all'in value?value.all:'any'in value?value.any:null
 const changeMode=(next:string)=>{
  if(next===mode)return
  if(next==='match')onChange(blankCondition())
  else if(next==='not')onChange({not:value})
  else onChange(next==='all'?{all:children||[value]}:{any:children||[value]})
 }
 return <fieldset className="hx-condition-node"><legend>{t("Condition")}</legend>
  <select aria-label={t("Condition combination")} value={mode} onChange={event=>changeMode(event.target.value)}><option value="match">{t("Compare a field")}</option><option value="all">{t("Match all")}</option><option value="any">{t("Match any")}</option><option value="not">{t("Does not match")}</option></select>
  {children&&<>{children.map((child,index)=><div className="hx-condition-child" key={index}><ConditionNode columns={columns} value={child} onChange={next=>onChange(mode==='all'?{all:children.map((item,i)=>i===index?next:item)}:{any:children.map((item,i)=>i===index?next:item)})}/><button type="button" className="btn-text" aria-label={t('Remove condition {number}',{number:index+1})} disabled={children.length===1} onClick={()=>onChange(mode==='all'?{all:children.filter((_,i)=>i!==index)}:{any:children.filter((_,i)=>i!==index)})}>{t("Remove")}</button></div>)}<button type="button" className="btn-text" disabled={children.length>=16} onClick={()=>onChange(mode==='all'?{all:[...children,blankCondition()]}:{any:[...children,blankCondition()]})}>{t("Add a condition")}</button></>}
  {'not'in value&&<ConditionNode columns={columns} value={value.not} onChange={next=>onChange({not:next})}/>}
  {'path'in value&&<div className="hx-condition-match">
   <div className="hx-condition-fields"><select aria-label={t("Condition source")} value={value.path[0]} onChange={event=>onChange({...value,path:[event.target.value,...value.path.slice(1)]})}><option value="input">{t("Starting input")}</option><option value="row">{t("Current record")}</option><option value="before">{t("Previous record")}</option><option value="steps">{t("Previous steps")}</option></select>
   {['row','before'].includes(value.path[0])&&columns.length>0&&<select aria-label={t("Record column")} value={value.path.length===2&&columns.some(column=>column.id===value.path[1])?value.path[1]:''} onChange={event=>{if(event.target.value)onChange({...value,path:[value.path[0],event.target.value]})}}><option value="">{t("Choose a column (or enter a field)")}</option>{columns.map(column=><option key={column.id} value={column.id}>{column.name}</option>)}</select>}
   <input className="hx-cell-input" aria-label={t("Condition field")} placeholder="amount / customer.name / 1.output" value={value.path.slice(1).join('.')} onChange={event=>onChange({...value,path:[value.path[0],...event.target.value.split('.')]})}/></div>
   <select aria-label={t("Condition comparison")} value={value.op} onChange={event=>{const op=event.target.value as typeof value.op;onChange({...value,op,value:op==='exists'?true:op==='in'?[Array.isArray(value.value)?value.value[0]:value.value]:['gt','gte','lt','lte'].includes(op)?0:op==='contains'?'':Array.isArray(value.value)?value.value[0]:value.value})}}>{Object.entries(operators).map(([op,label])=><option key={op} value={op}>{t(label)}</option>)}</select>
   {value.op==='in'&&Array.isArray(value.value)?<div>{value.value.map((item,index)=><div className="hx-condition-child" key={index}><ScalarEditor label={t('Candidate {number}',{number:index+1})} value={item} onChange={next=>onChange({...value,value:(value.value as ConditionScalar[]).map((old,i)=>i===index?next:old)})}/><button type="button" className="btn-text" aria-label={t('Remove candidate {number}',{number:index+1})} disabled={(value.value as ConditionScalar[]).length===1} onClick={()=>onChange({...value,value:(value.value as ConditionScalar[]).filter((_,i)=>i!==index)})}>{t("Remove")}</button></div>)}<button type="button" className="btn-text" disabled={(value.value as ConditionScalar[]).length>=100} onClick={()=>onChange({...value,value:[...(value.value as ConditionScalar[]),'']})}>{t("Add a candidate")}</button></div>:<ScalarEditor label={t("Comparison value")} value={value.value as ConditionScalar} kind={value.op==='exists'?'boolean':value.op==='contains'?'string':['gt','gte','lt','lte'].includes(value.op)?'number':undefined} onChange={next=>onChange({...value,value:next})}/>}
  </div>}
 </fieldset>
}
