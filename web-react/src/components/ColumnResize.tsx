import React, {useRef, useState} from 'react'
const clamp=(width:number)=>Math.max(80,Math.min(600,Math.round(width)))
export function ColumnResize({name,width,save}:{name:string;width:number;save:(width:number)=>Promise<unknown>}) {
 const drag=useRef<{start:number;width:number}|null>(null)
 const [preview,setPreview]=useState<number|null>(null),[busy,setBusy]=useState(false)
 const commit=async(next:number)=>{setBusy(true);try{await save(clamp(next))}finally{setBusy(false);setPreview(null)}}
 return <span className="hx-column-resize" role="separator" aria-label={`${name}の幅を調整`} aria-orientation="vertical" aria-valuemin={80} aria-valuemax={600} aria-valuenow={preview??width} aria-disabled={busy} tabIndex={0}
 onKeyDown={e=>{if(busy||!['ArrowLeft','ArrowRight'].includes(e.key))return;e.preventDefault();void commit(width+(e.key==='ArrowLeft'?-10:10))}}
 onPointerDown={e=>{if(busy)return;e.preventDefault();drag.current={start:e.clientX,width};e.currentTarget.setPointerCapture(e.pointerId)}}
 onPointerMove={e=>{if(drag.current)setPreview(clamp(drag.current.width+e.clientX-drag.current.start))}}
 onPointerUp={e=>{if(!drag.current)return;const next=clamp(drag.current.width+e.clientX-drag.current.start);drag.current=null;void commit(next)}}
 onPointerCancel={()=>{drag.current=null;setPreview(null)}}
 >{preview!==null&&<span className="hx-column-width-label">{preview}px</span>}</span>
}
