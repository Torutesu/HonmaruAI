/// <reference types="node" />
import {afterEach,expect,test,vi} from 'vitest'
import source from '../public/startup-v2.js?raw'
import index from '../index.html?raw'
import {readFileSync} from 'node:fs'
const styles=readFileSync(new URL('../public/startup-v1.css',import.meta.url),'utf8')

afterEach(()=>vi.useRealTimers())
function boot(locale='ja') {
  vi.useFakeTimers()
  const message={textContent:''}
  let retryClick:(event:any)=>void=()=>{}
  const retry={textContent:'',addEventListener:(_name:string,fn:any)=>{retryClick=fn}}
  const panel={querySelector:(selector:string)=>selector==='[data-startup-message]'?message:retry,remove:vi.fn()}
  const root={childElementCount:0}
  let changed:()=>void=()=>{}
  const listeners:Record<string,((event:any)=>void)|undefined>={}
  const disconnect=vi.fn()
  class Observer { constructor(fn:()=>void){changed=fn} observe(){} disconnect=disconnect }
  const reload=vi.fn(),storage={getItem:vi.fn(()=>locale)}
  const window={addEventListener:(name:string,fn:any)=>{listeners[name]=fn},removeEventListener:vi.fn((name:string)=>{listeners[name]=undefined})}
  new Function('document','navigator','localStorage','location','window','MutationObserver','ErrorEvent',source)(
    {getElementById:(id:string)=>id==='root'?root:panel},
    {language:'en-US'},storage,{search:'',reload},window,Observer,class {},
  )
  return {message,retryClick:()=>retryClick({preventDefault:vi.fn()}),root,changed,panel,disconnect,reload,error:()=>listeners.error,pagehide:(persisted=false)=>listeners.pagehide?.({persisted}),storage}
}
test('a stalled bundle leaves a translated retry without reloading or altering the session',()=>{
  const b=boot()
  expect(b.message.textContent).toContain('開いています')
  vi.advanceTimersByTime(12000)
  expect(b.message.textContent).toContain('再読み込み')
  expect(b.reload).not.toHaveBeenCalled()
  b.retryClick()
  expect(b.reload).toHaveBeenCalledOnce()
  expect(b.storage.getItem).toHaveBeenCalledWith('locale')
})
test('module download failure surfaces the recovery message immediately',()=>{
  const b=boot('en')
  b.error()?.({target:{tagName:'SCRIPT'}})
  expect(b.message.textContent).toContain('Check your connection')
})
test('React mounting cancels the timer but leaves recovery available if the root later empties',()=>{
  const b=boot()
  b.root.childElementCount=1;b.changed()
  expect(b.panel.remove).not.toHaveBeenCalled()
  expect(b.disconnect).not.toHaveBeenCalled()
  expect(b.error()).toBeDefined()
  expect(vi.getTimerCount()).toBe(0)
  b.root.childElementCount=0;b.changed()
  vi.advanceTimersByTime(12000)
  expect(b.message.textContent).toContain('再読み込み')
  expect(b.reload).not.toHaveBeenCalled()
  b.pagehide(true);expect(b.disconnect).not.toHaveBeenCalled()
  b.pagehide();expect(b.disconnect).toHaveBeenCalledOnce()
  expect(b.error()).toBeUndefined()
  expect(vi.getTimerCount()).toBe(0)
})
test('recovery markup and scripts precede the module and preserve the offline shell marker',()=>{
  expect(index).toContain('<div id="root"></div>')
  expect(index.indexOf('id="app-startup"')).toBeLessThan(index.indexOf('src="/startup-v2.js"'))
  expect(index.indexOf('src="/startup-v2.js"')).toBeLessThan(index.indexOf('src="/src/main.tsx"'))
  expect(index).toContain('href="/startup-v1.css"')
  expect(styles).toContain('body:has(#root > *) #app-startup { display: none; }')
})
