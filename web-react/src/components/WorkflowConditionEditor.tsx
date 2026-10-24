import React,{useState} from 'react'
import type {WorkflowCondition,ConditionScalar,Table} from '../utils/harness'
export const blankCondition=():WorkflowCondition=>({path:['input','value'],op:'eq',value:''})
const operators={eq:'等しい',neq:'等しくない',gt:'より大きい',gte:'以上',lt:'より小さい',lte:'以下',contains:'文字を含む',in:'候補のいずれか',exists:'項目が存在する'}
const scalarType=(value:ConditionScalar)=>value===null?'null':typeof value
function ScalarEditor({value,onChange,kind, label}:{value:ConditionScalar;onChange:(value:ConditionScalar)=>void;kind?:string;label:string}) {
 const type=kind||scalarType(value)
 return <span className="hx-condition-value">
  {!kind&&<select aria-label={`${label}の種類`} value={type} onChange={event=>onChange(event.target.value==='number'?0:event.target.value==='boolean'?true:event.target.value==='null'?null:'')}><option value="string">文字</option><option value="number">数値</option><option value="boolean">真偽</option><option value="null">空値（null）</option></select>}
  {type==='boolean'?<select aria-label={label} value={String(value)} onChange={event=>onChange(event.target.value==='true')}><option value="true">はい</option><option value="false">いいえ</option></select>:type==='null'?<span>空値</span>:<input className="hx-cell-input" aria-label={label} type={type==='number'?'number':'text'} step={type==='number'?'any':undefined} maxLength={4000} required={type==='number'} value={value==null?'':String(value)} onChange={event=>{const raw=event.target.value;onChange(type==='number'&&raw!==''&&Number.isFinite(Number(raw))?Number(raw):raw)}}/>}
 </span>
}
function size(condition:WorkflowCondition,depth=0):{nodes:number;depth:number} {
 const children='all'in condition?condition.all:'any'in condition?condition.any:'not'in condition?[condition.not]:[]
 return children.reduce((total,child)=>{const childSize=size(child,depth+1);return {nodes:total.nodes+childSize.nodes,depth:Math.max(total.depth,childSize.depth)}},{nodes:1,depth})
}
export function WorkflowConditionEditor({value,onChange,columns=[]}:{value:WorkflowCondition;onChange:(value:WorkflowCondition)=>void;columns?:Table["columns"]}) {
 const [error,setError]=useState('')
 const change=(next:WorkflowCondition)=>{const count=size(next);if(count.nodes>64||count.depth>8){setError('条件は64項目、入れ子は8段までです。');return}setError('');onChange(next)}
 return <div className="hx-condition-editor"><ConditionNode value={value} onChange={change} columns={columns}/>{error&&<p role="alert">{error}</p>}</div>
}
function ConditionNode({value,onChange,columns=[]}:{value:WorkflowCondition;onChange:(value:WorkflowCondition)=>void;columns?:Table["columns"]}) {
 const mode='all'in value?'all':'any'in value?'any':'not'in value?'not':'match'
 const children='all'in value?value.all:'any'in value?value.any:null
 const changeMode=(next:string)=>{
  if(next===mode)return
  if(next==='match')onChange(blankCondition())
  else if(next==='not')onChange({not:value})
  else onChange(next==='all'?{all:children||[value]}:{any:children||[value]})
 }
 return <fieldset className="hx-condition-node"><legend>条件</legend>
  <select aria-label="条件の組み合わせ" value={mode} onChange={event=>changeMode(event.target.value)}><option value="match">項目を比較</option><option value="all">すべて一致</option><option value="any">どれか一致</option><option value="not">一致しない</option></select>
  {children&&<>{children.map((child,index)=><div className="hx-condition-child" key={index}><ConditionNode columns={columns} value={child} onChange={next=>onChange(mode==='all'?{all:children.map((item,i)=>i===index?next:item)}:{any:children.map((item,i)=>i===index?next:item)})}/><button type="button" className="btn-text" aria-label={`条件${index+1}を削除`} disabled={children.length===1} onClick={()=>onChange(mode==='all'?{all:children.filter((_,i)=>i!==index)}:{any:children.filter((_,i)=>i!==index)})}>削除</button></div>)}<button type="button" className="btn-text" disabled={children.length>=16} onClick={()=>onChange(mode==='all'?{all:[...children,blankCondition()]}:{any:[...children,blankCondition()]})}>条件を追加</button></>}
  {'not'in value&&<ConditionNode columns={columns} value={value.not} onChange={next=>onChange({not:next})}/>}
  {'path'in value&&<>
   <div className="hx-condition-fields"><select aria-label="条件の参照元" value={value.path[0]} onChange={event=>onChange({...value,path:[event.target.value,...value.path.slice(1)]})}><option value="input">開始時の入力</option><option value="row">現在のレコード</option><option value="before">変更前のレコード</option><option value="steps">前のステップ</option></select>
   {['row','before'].includes(value.path[0])&&columns.length>0&&<select aria-label="レコードの列" value={value.path.length===2&&columns.some(column=>column.id===value.path[1])?value.path[1]:''} onChange={event=>{if(event.target.value)onChange({...value,path:[value.path[0],event.target.value]})}}><option value="">列を選択（または項目を直接入力）</option>{columns.map(column=><option key={column.id} value={column.id}>{column.name}</option>)}</select>}
   <input className="hx-cell-input" aria-label="条件の項目" placeholder="amount / customer.name / 1.output" value={value.path.slice(1).join('.')} onChange={event=>onChange({...value,path:[value.path[0],...event.target.value.split('.')]})}/></div>
   <select aria-label="条件の比較方法" value={value.op} onChange={event=>{const op=event.target.value as typeof value.op;onChange({...value,op,value:op==='exists'?true:op==='in'?[Array.isArray(value.value)?value.value[0]:value.value]:['gt','gte','lt','lte'].includes(op)?0:op==='contains'?'':Array.isArray(value.value)?value.value[0]:value.value})}}>{Object.entries(operators).map(([op,label])=><option key={op} value={op}>{label}</option>)}</select>
   {value.op==='in'&&Array.isArray(value.value)?<div>{value.value.map((item,index)=><div className="hx-condition-child" key={index}><ScalarEditor label={`候補${index+1}`} value={item} onChange={next=>onChange({...value,value:(value.value as ConditionScalar[]).map((old,i)=>i===index?next:old)})}/><button type="button" className="btn-text" aria-label={`候補${index+1}を削除`} disabled={(value.value as ConditionScalar[]).length===1} onClick={()=>onChange({...value,value:(value.value as ConditionScalar[]).filter((_,i)=>i!==index)})}>削除</button></div>)}<button type="button" className="btn-text" disabled={(value.value as ConditionScalar[]).length>=100} onClick={()=>onChange({...value,value:[...(value.value as ConditionScalar[]),'']})}>候補を追加</button></div>:<ScalarEditor label="比較する値" value={value.value as ConditionScalar} kind={value.op==='exists'?'boolean':value.op==='contains'?'string':['gt','gte','lt','lte'].includes(value.op)?'number':undefined} onChange={next=>onChange({...value,value:next})}/>}
  </>}
 </fieldset>
}
