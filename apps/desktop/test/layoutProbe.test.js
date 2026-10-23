import {runInNewContext} from 'node:vm'
import {expect,it} from 'vitest'
import {LAYOUT_PROBE} from '../src/layoutProbe.js'
function element(props={}){return {parentElement:null,childElementCount:1,style:{display:'block',visibility:'visible',opacity:'1'},getBoundingClientRect:()=>({width:100,height:100}),...props}}
function inspect(root,startup,body){return runInNewContext(LAYOUT_PROBE,{document:{body,getElementById:id=>id==='root'?root:startup},getComputedStyle:e=>e.style})}
it('returns flags only, with no private document text or attributes',()=>{
 const root=element(),body=element({innerText:'private token and message',querySelectorAll:()=>[]})
 expect(inspect(root,null,body)).toBe(31)
 expect(typeof inspect(root,null,body)).toBe('number')
})
it('distinguishes hidden ancestors, zero-size root, and visible recovery panel',()=>{
 const hidden=element({style:{display:'none',visibility:'visible',opacity:'1'}})
 const root=element({parentElement:hidden,getBoundingClientRect:()=>({width:0,height:0})})
 const body=element({innerText:'',querySelectorAll:()=>[]})
 expect(inspect(root,element(),body)).toBe(67)
 expect(inspect(null,null,null)).toBe(0)
})
it('counts visible media but not invisible or transparent media',()=>{
 const transparent=element({style:{display:'block',visibility:'visible',opacity:'0'}})
 const body=element({innerText:'',querySelectorAll:()=>[transparent]})
 expect(inspect(null,null,body)).toBe(0)
 body.querySelectorAll=()=>[element()]
 expect(inspect(null,null,body)).toBe(32)
})
