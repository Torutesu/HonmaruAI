import React, {useEffect, useRef, useState} from 'react'
import {Icon} from './Icon'
import type {Column, PersonalViews, View} from '../utils/harness'
export function PersonalViewControls({view,columns,state,save,onSelect,onSettings}:{view:View;columns:Column[];state:PersonalViews;save:(next:PersonalViews)=>Promise<void>;onSelect:(id:string)=>void;onSettings:()=>void}) {
 const [open,setOpen]=useState<'fields'|'view'|null>(null),[name,setName]=useState(view.name),[busy,setBusy]=useState(false),[error,setError]=useState('')
 const layout=state.layouts[view.id], ids=columns.map(c=>c.id)
 const [order,setOrder]=useState(layout?.order || ids),[widths,setWidths]=useState<Record<string,number>>(layout?.widths || {})
 const root=useRef<HTMLDivElement>(null), dragged=useRef<string|null>(null)
 useEffect(()=>{const close=(e:PointerEvent)=>{if(!busy&&!root.current?.contains(e.target as Node))setOpen(null)};document.addEventListener('pointerdown',close);return()=>document.removeEventListener('pointerdown',close)},[busy])
 const perform=async(next:PersonalViews,id?:string)=>{setBusy(true);setError('');try{await save(next);setOpen(null);if(id)onSelect(id)}catch(e){setError(e instanceof Error?e.message:String(e))}finally{setBusy(false)}}
 const move=(id:string,delta:number)=>{const next=[...order],i=next.indexOf(id);[next[i],next[i+delta]]=[next[i+delta],next[i]];setOrder(next)}
 const personal=view.id.startsWith('personal_')
 return <div className="hx-view-controls" ref={root} onKeyDown={e=>{if(e.key==='Escape'&&!busy)setOpen(null)}}>
 <button className="pill-btn quiet" aria-expanded={open==='fields'} onClick={()=>setOpen(open==='fields'?null:'fields')}><Icon name="sliders" size={14}/>フィールド</button>
 <button className="pill-btn quiet" aria-expanded={open==='view'} onClick={()=>{setName(view.name);setOpen(open==='view'?null:'view')}}><Icon name="plus" size={14}/>新しいビュー{personal?' / 編集':''}</button>
 {open && <div className="hx-view-popover hx-personal-popover" role="dialog" aria-label={open==='fields'?'列の表示設定':'個人ビュー'}>
 <strong>{open==='fields'?'フィールド':'個人ビュー'}</strong><p className="hx-view-hint">自分だけに適用・同じアカウントの端末間で同期</p>
 {open==='fields'?<><div className="hx-column-list">{order.map((id,i)=>{const c=columns.find(c=>c.id===id);return c&&<div className="hx-column-setting" key={id} draggable={!busy} onDragStart={()=>{dragged.current=id}} onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault();const from=dragged.current;if(!from||from===id)return;const next=order.filter(c=>c!==from);next.splice(next.indexOf(id),0,from);setOrder(next);dragged.current=null}}><span className="hx-column-grip" aria-hidden="true">⠿</span><span className="hx-column-label">{c.name}</span><button aria-label={`${c.name}を左へ`} disabled={busy||i===0} onClick={()=>move(id,-1)}><Icon name="chevron-left" size={12}/></button><button aria-label={`${c.name}を右へ`} disabled={busy||i===order.length-1} onClick={()=>move(id,1)}><Icon name="chevron-right" size={12}/></button><input type="number" min={80} max={600} step={10} aria-label={`${c.name}の列幅`} value={widths[id]||180} onChange={e=>setWidths({...widths,[id]:Number(e.target.value)})}/><small>px</small></div>})}</div><div className="hx-view-popover-footer"><button className="pill-btn quiet" disabled={busy} onClick={()=>{setOrder(ids);setWidths({})}}>リセット</button><button className="pill-btn" disabled={busy||Object.values(widths).some(w=>w<80||w>600)} onClick={()=>void perform({...state,layouts:{...state.layouts,[view.id]:{order,widths}}})}>保存</button></div><button className="pill-btn quiet" onClick={onSettings}>フィールド定義を管理</button></>:<>
 <label>ビュー名<input autoFocus className="hx-cell-input" maxLength={40} value={name} onChange={e=>setName(e.target.value)}/></label>
 <p className="hx-view-hint">現在のフィルター・グループ・列設定を複製します。</p>
 <div className="hx-view-popover-footer">{personal&&<button className="pill-btn quiet" disabled={busy||!name.trim()} onClick={()=>void perform({...state,views:state.views.map(v=>v.id===view.id?{...v,name:name.trim()}:v)})}>名前を保存</button>}<button className="pill-btn" disabled={busy||!name.trim()||state.views.length>=12} onClick={()=>{const id=`personal_${crypto.randomUUID().replace(/-/g,'').slice(0,16)}`;const {rows,lanes,days,undated,values,...definition}=view;void perform({...state,activeView:id,views:[...state.views,{...definition,id,name:name.trim()}],layouts:{...state.layouts,[id]:{order,widths}}},id)}}>個人ビューを作成</button></div></>}
 {error&&<p role="alert" className="form-error">{error}</p>}
 </div>}
 </div>
}
