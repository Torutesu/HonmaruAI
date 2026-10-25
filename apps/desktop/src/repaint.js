// React can populate the window after did-finish-load. A bounded repaint
// sequence covers that interval without reloading, changing geometry or
// touching page contents. Invalidating is only a paint request, not evidence
// that a stale macOS surface recovered.
export function installDelayedRepaint(contents,{visible=()=>true,delays=[0,1000,3000,10000]}={}) {
 const timers=new Set()
 const clear=()=>{for(const timer of timers)clearTimeout(timer);timers.clear()}
 const repaint=()=>{if(!contents.isDestroyed()&&visible())contents.invalidate()}
 const navigation=details=>{if(details.isMainFrame&&!details.isSameDocument)clear()}
 const loaded=()=>{
  clear()
  for(const delay of delays){
   if(delay===0){repaint();continue}
   const timer=setTimeout(()=>{timers.delete(timer);repaint()},delay)
   timer.unref?.();timers.add(timer)
  }
 }
 const dispose=()=>{clear();contents.removeListener('did-start-navigation',navigation);contents.removeListener('did-finish-load',loaded);contents.removeListener('destroyed',dispose)}
 contents.on('did-start-navigation',navigation);contents.on('did-finish-load',loaded);contents.on('destroyed',dispose)
 return dispose
}
