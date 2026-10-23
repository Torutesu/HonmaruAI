import {useEffect,useRef,useState} from 'react'

// A pending send may finish after navigation or after the user toggles modes.
// Only the exact composer intent that started it may open a thread.
export function useComposerThreadMode<T>(scope:unknown,onOpen:(root:T)=>void){
 const [,render]=useState(0)
 const state=useRef({scope,enabled:false,revision:0,alive:true})
 const open=useRef(onOpen);open.current=onOpen
 if(state.current.scope!==scope)state.current={scope,enabled:false,revision:state.current.revision+1,alive:true}
 useEffect(()=>{state.current.alive=true;return()=>{state.current.alive=false}},[])
 const toggle=()=>{state.current.enabled=!state.current.enabled;state.current.revision++;render(x=>x+1)}
 const capture=()=>{
  const intent=state.current,revision=intent.revision
  if(!intent.enabled)return undefined
  return(root:T)=>{
   if(state.current!==intent||!intent.alive||!intent.enabled||intent.revision!==revision)return
   intent.enabled=false;intent.revision++;render(x=>x+1);open.current(root)
  }
 }
 return{enabled:state.current.enabled,toggle,capture}
}
