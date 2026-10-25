// Coalesce bursts of uploads, and refetch after reconnect/focus. No file
// content is transported by these events or retained in this subscription.
export function subscribeWorkspaceFileRefresh(refresh:()=>void,target:EventTarget|undefined=typeof window==='undefined'?undefined:window){
 if(!target)return ()=>{}
 let timer:ReturnType<typeof setTimeout>|undefined
 const schedule=()=>{if(timer!==undefined)return;timer=setTimeout(()=>{timer=undefined;refresh()},150)}
 const event=(event:Event)=>{const name=(event as CustomEvent).detail?.name;if(name==='workspace_files_changed'||name==='reset')schedule()}
 target.addEventListener('honmaru:jam',event);target.addEventListener('focus',schedule)
 return ()=>{if(timer!==undefined)clearTimeout(timer);target.removeEventListener('honmaru:jam',event);target.removeEventListener('focus',schedule)}
}
