import React,{useEffect,useRef,useState} from 'react'
import type {PDFDocumentProxy,RenderTask,TextLayer} from 'pdfjs-dist'
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import type {FileRef} from '../types/card'
import {Dialog} from './Dialog'
import {Icon} from './Icon'
import {FileConversationButton} from './FileConversationButton'
import {documentBytes,documentKind,csvRows,documentMatches,pdfTextRuns} from '../utils/documentPreview'
import {downloadUrl} from '../utils/media'
import './DocumentPreview.css'

export default function DocumentPreview({file,href,onClose}:{file:FileRef;href:string;onClose:()=>void}){
 const kind=documentKind(file.type,file.name)
 const scope=`${file.id}:${href}`
 const [loaded,setLoaded]=useState<{scope:string;bytes:Uint8Array}|null>(null),[error,setError]=useState(''),[attempt,setAttempt]=useState(0)
 useEffect(()=>{
  const key=(event:KeyboardEvent)=>{
   if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='f'&&!event.altKey){
    const input=document.querySelector<HTMLInputElement>('.document-preview input[type=search]')
    if(input){event.preventDefault();event.stopPropagation();input.focus();input.select()}
   }
  }
  document.addEventListener('keydown',key,true);return()=>document.removeEventListener('keydown',key,true)
 },[])
 useEffect(()=>{
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),30000);let live=true
  setLoaded(null);setError('')
  void documentBytes(href,kind==='pdf'?25*1024*1024:2*1024*1024,controller.signal)
   .then(value=>{if(live)setLoaded({scope,bytes:value})},reason=>{if(live)setError(controller.signal.aborted?'読み込みがタイムアウトしました。再試行してください。':reason.message||'ファイルを読み込めませんでした。')})
   .finally(()=>clearTimeout(timer))
  return()=>{live=false;controller.abort();clearTimeout(timer)}
 },[scope,kind,attempt])
 const bytes=loaded?.scope===scope?loaded.bytes:null
 return <Dialog title={file.name} className="document-preview" onClose={onClose}
  footer={<><FileConversationButton fileId={file.id} onOpen={onClose}/><a href={downloadUrl(href)} target="_blank" rel="noopener noreferrer"><Icon name="download" size={16}/>ダウンロード</a></>}>
  {error?<p role="alert">{error}<button type="button" onClick={()=>setAttempt(n=>n+1)}>再試行</button></p>
   :bytes?kind==='pdf'?<PdfDocument key={`${scope}:${attempt}`} bytes={bytes}/>:<TextDocument bytes={bytes} csv={kind==='csv'}/>
   :<p role="status">ファイルを読み込んでいます…</p>}
 </Dialog>
}

function Highlight({text,query,firstOnly=false,flexibleWhitespace=false}:{text:string;query:string;firstOnly?:boolean;flexibleWhitespace?:boolean}){
 if(!query)return <>{text}</>
 const out:React.ReactNode[]=[];let from=0
 for(const {start,end} of documentMatches(text,query,firstOnly?1:1000,flexibleWhitespace)){
  out.push(text.slice(from,start),<mark key={start}>{text.slice(start,end)}</mark>);from=end
 }
 out.push(text.slice(from));return <>{out}</>
}
function TextDocument({bytes,csv}:{bytes:Uint8Array;csv:boolean}){
 const [encoding,setEncoding]=useState(()=>bytes[0]===255&&bytes[1]===254?'utf-16le':bytes[0]===254&&bytes[1]===255?'utf-16be':'utf-8')
 const text=new TextDecoder(encoding).decode(bytes).replace(/^\uFEFF/,'')
 const [query,setQuery]=useState(''),[plain,setPlain]=useState(false)
 const content=useRef<HTMLDivElement>(null),[count,setCount]=useState(0),[selected,setSelected]=useState(0)
 useEffect(()=>{setCount(content.current?.querySelectorAll('mark').length||0);setSelected(0)},[query,plain,bytes,encoding])
 useEffect(()=>{
  const marks=content.current?.querySelectorAll('mark')
  marks?.forEach((mark,i)=>mark.toggleAttribute('data-current',i===selected))
  marks?.[selected]?.scrollIntoView?.({block:'center',inline:'nearest'})
 },[selected,query,plain,bytes,encoding])
 let rows:string[][]=[],truncated=false,problem=''
 if(csv&&!plain){try{({rows,truncated}=csvRows(text))}catch(error){problem=(error as Error).message}}
 return <>
  <div className="document-tools"><label>文書内を検索<input type="search" value={query} onChange={e=>setQuery(e.target.value)} maxLength={200}/></label>
   {query&&<><span role="status">{count?`${selected+1} / ${count}`:'一致なし'}</span>
    <button type="button" aria-label="前の一致箇所" disabled={!count} onClick={()=>setSelected(n=>(n-1+count)%count)}><Icon name="chevron-left" size={16}/></button>
    <button type="button" aria-label="次の一致箇所" disabled={!count} onClick={()=>setSelected(n=>(n+1)%count)}><Icon name="chevron-right" size={16}/></button></>}
   {csv&&<button type="button" onClick={()=>setPlain(value=>!value)}>{plain?'表で表示':'テキストで表示'}</button>}
   <label>文字コード<select value={encoding} onChange={event=>setEncoding(event.target.value)}><option value="utf-8">UTF-8</option><option value="shift_jis">Shift JIS</option><option value="utf-16le">UTF-16 LE</option><option value="utf-16be">UTF-16 BE</option></select></label>
  </div>
  {problem&&<p role="alert">{problem}</p>}
  {truncated&&<p role="status">表示上限は5,000行・100列・20,000セルです。全体はダウンロードして確認できます。</p>}
  {query&&<small>テキストは先頭1,000箇所、表は各セルの最初の一致を表示します。</small>}
  <div className="document-content" tabIndex={0} ref={content}>
   {csv&&!plain&&!problem?<table className="document-csv"><tbody>{rows.map((row,i)=><tr key={i}><th scope="row">{i+1}</th>{row.map((cell,j)=><td key={j}><Highlight text={cell} query={query} firstOnly/></td>)}</tr>)}</tbody></table>
    :<pre className="document-text"><Highlight text={text} query={query}/></pre>}
  </div>
 </>
}
function PdfDocument({bytes}:{bytes:Uint8Array}){
 const [pdf,setPdf]=useState<PDFDocumentProxy|null>(null),[error,setError]=useState('')
 const [page,setPage]=useState(1),[zoom,setZoom]=useState(1),[query,setQuery]=useState('')
 const [hits,setHits]=useState<number[]>([]),[searching,setSearching]=useState(false),[searched,setSearched]=useState(false),[partial,setPartial]=useState(false)
 const searchSequence=useRef(0),texts=useRef(new Map<number,string>())
 useEffect(()=>{
  setPdf(null);setError('');setPage(1)
  let live=true,task:ReturnType<typeof import('pdfjs-dist')['getDocument']>|undefined
  void import('pdfjs-dist').then(lib=>{
   if(!live)return
   lib.GlobalWorkerOptions.workerSrc=pdfWorkerUrl
   task=lib.getDocument({data:bytes.slice(),cMapUrl:new URL('/pdfjs/cmaps/',location.origin).href,cMapPacked:true,
    standardFontDataUrl:new URL('/pdfjs/standard_fonts/',location.origin).href,useWasm:false,maxImageSize:16_000_000,canvasMaxAreaInBytes:32_000_000})
   return task.promise
  }).then(value=>{if(live&&value)setPdf(value)}).catch(reason=>{
   if(live)setError(reason?.name==='PasswordException'?'パスワードで保護されたPDFです。ダウンロードして開いてください。':'PDFを表示できませんでした。ダウンロードして内容を確認してください。')
  })
  return()=>{live=false;searchSequence.current++;void task?.destroy()}
 },[bytes])
 const search=async(event:React.FormEvent)=>{
  event.preventDefault();if(!pdf)return
  const ticket=++searchSequence.current,needle=query.trim()
  setHits([]);setSearched(false);setPartial(false);if(!needle){setSearching(false);return}setSearching(true)
  const found:number[]=[];let count=0,limited=pdf.numPages>1000
  try{
   for(let i=1;i<=Math.min(pdf.numPages,1000);i++){
    if(ticket!==searchSequence.current)return
    let text=texts.current.get(i)
    if(text===undefined){const item=await pdf.getPage(i),content=await item.getTextContent();text=pdfTextRuns(content.items).text;texts.current.set(i,text)}
    count+=text.length;if(count>10_000_000){limited=true;break}
    if(documentMatches(text,needle,1,true).length)found.push(i)
   }
   if(ticket===searchSequence.current){setHits(found);setPartial(limited);setSearched(true);if(found.length)setPage(found[0])}
  }catch{if(ticket===searchSequence.current){setPartial(true);setHits(found);setSearched(true)}}
  finally{if(ticket===searchSequence.current)setSearching(false)}
 }
 if(error)return <p role="alert">{error}</p>
 if(!pdf)return <p role="status">PDFを準備しています…</p>
 return <>
  <div className="document-tools">
   <button type="button" disabled={page===1} onClick={()=>setPage(n=>n-1)} aria-label="前のページ"><Icon name="chevron-left" size={16}/></button>
   <label>ページ<input type="number" min={1} max={pdf.numPages} value={page} onChange={e=>{const n=Number(e.target.value);if(Number.isInteger(n)&&n>=1&&n<=pdf.numPages)setPage(n)}}/></label><span>/ {pdf.numPages}</span>
   <button type="button" disabled={page===pdf.numPages} onClick={()=>setPage(n=>n+1)} aria-label="次のページ"><Icon name="chevron-right" size={16}/></button>
   <label>倍率<select value={zoom} onChange={e=>setZoom(Number(e.target.value))}>{[0.5,0.75,1,1.25,1.5,2].map(n=><option key={n} value={n}>{n*100}%</option>)}</select></label>
   <form onSubmit={search}><label>文書内を検索<input type="search" value={query} onChange={e=>{setQuery(e.target.value);searchSequence.current++;setSearching(false);setSearched(false);setHits([])}} maxLength={200}/></label><button type="submit" disabled={searching||!query.trim()}>{searching?'検索中…':'検索'}</button></form>
  </div>
  {searched&&<div className="document-hits" role="status">{hits.length?`${hits.length}ページで一致`:'一致するテキストはありません。'}{partial&&' 全ページの検索は完了していません。'}{hits.map(n=><button type="button" key={n} onClick={()=>setPage(n)} aria-pressed={page===n}>{n}ページ</button>)}</div>}
  <PdfPage key={`${page}:${zoom}`} pdf={pdf} page={page} zoom={zoom} query={searched?query.trim():''}/>
 </>
}
function PdfPage({pdf,page,zoom,query}:{pdf:PDFDocumentProxy;page:number;zoom:number;query:string}){
 const canvas=useRef<HTMLCanvasElement>(null),overlay=useRef<HTMLDivElement>(null),surface=useRef<HTMLDivElement>(null)
 const [layerData,setLayerData]=useState<({layer:TextLayer}&ReturnType<typeof pdfTextRuns>)|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(true)
 useEffect(()=>{
  if(!layerData)return
  const matches=documentMatches(layerData.text,query,1000,true)
  let next=0
  layerData.layer.textDivs.forEach((span,i)=>{
   const run=layerData.runs[i];if(!run)return
   span.replaceChildren()
   while(next<matches.length&&matches[next].end<=run.start)next++
   let from=0
   for(let j=next;j<matches.length&&matches[j].start<run.end;j++){
    const start=Math.max(0,matches[j].start-run.start),end=Math.min(run.text.length,matches[j].end-run.start)
    if(start>=end)continue
    span.append(document.createTextNode(run.text.slice(from,start)))
    const mark=document.createElement('mark');mark.textContent=run.text.slice(start,end);span.append(mark);from=end
   }
   span.append(document.createTextNode(run.text.slice(from)))
  })
 },[query,layerData])
 useEffect(()=>{
  let live=true,task:RenderTask|undefined,layer:TextLayer|undefined
  void pdf.getPage(page).then(async item=>{
   if(!live||!canvas.current||!overlay.current||!surface.current)return
   const natural=item.getViewport({scale:1}),scale=700*zoom/natural.width
   const viewport=item.getViewport({scale}),ratio=Math.min(devicePixelRatio||1,2,Math.sqrt(8_000_000/(viewport.width*viewport.height)))
   const node=canvas.current;node.width=Math.max(1,Math.floor(viewport.width*ratio));node.height=Math.max(1,Math.floor(viewport.height*ratio))
   node.style.width=`${viewport.width}px`;node.style.height=`${viewport.height}px`
   surface.current.style.width=`${viewport.width}px`;surface.current.style.height=`${viewport.height}px`
   overlay.current.style.setProperty('--total-scale-factor',String(viewport.scale*viewport.userUnit))
   const container=overlay.current
   task=item.render({canvas:node,viewport,transform:[ratio,0,0,ratio,0,0]})
   await Promise.all([task.promise,(async()=>{
    const [content,lib]=await Promise.all([item.getTextContent(),import('pdfjs-dist')])
    if(!live)return
    layer=new lib.TextLayer({textContentSource:content,container,viewport})
    await layer.render()
    if(live)setLayerData({layer,...pdfTextRuns(content.items)})
   })()])
  }).catch(reason=>{if(live&&reason?.name!=='RenderingCancelledException')setError('このページを描画できませんでした。')})
   .finally(()=>{if(live)setBusy(false)})
  return()=>{live=false;task?.cancel();layer?.cancel()}
 },[pdf,page,zoom])
 return <div className="document-content">{busy&&<p role="status">ページを描画しています…</p>}{error&&<p role="alert">{error}</p>}
  <div className="document-pdf-page" ref={surface}>
   <canvas ref={canvas} aria-label={`${page}ページのプレビュー`} role="img"/>
   <div className="document-pdf-text" ref={overlay} aria-label={`${page}ページのテキスト`}/>
  </div>
  <details className="document-extracted"><summary>ページのテキスト</summary><pre><Highlight text={layerData?.text||''} query={query} flexibleWhitespace/></pre></details>
 </div>
}
