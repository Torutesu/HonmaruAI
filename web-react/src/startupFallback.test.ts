import {afterEach,expect,test,vi} from 'vitest'
import source from '../public/startup-v1.js?raw'
import index from '../index.html?raw'

afterEach(()=>vi.useRealTimers())
function boot(locale='ja') {
  vi.useFakeTimers()
  const message={textContent:''}
  let retryClick:(event:any)=>void=()=>{}
  const retry={textContent:'',addEventListener:(_name:string,fn:any)=>{retryClick=fn}}
  const panel={querySelector:(selector:string)=>selector==='[data-startup-message]'?message:retry,remove:vi.fn()}
  const root={childElementCount:0}
  let changed:()=>void=()=>{}
  let error:((event:any)=>void)|undefined
  const disconnect=vi.fn()
  class Observer { constructor(fn:()=>void){changed=fn} observe(){} disconnect=disconnect }
  const reload=vi.fn(),storage={getItem:vi.fn(()=>locale)}
  const window={addEventListener:(_name:string,fn:any)=>{error=fn},removeEventListener:vi.fn(()=>{error=undefined})}
  new Function('document','navigator','localStorage','location','window','MutationObserver','ErrorEvent',source)(
    {getElementById:(id:string)=>id==='root'?root:panel},
    {language:'en-US'},storage,{search:'',reload},window,Observer,class {},
  )
  return {message,retryClick:()=>retryClick({preventDefault:vi.fn()}),root,changed,panel,disconnect,reload,error:()=>error,storage}
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
test('React mounting removes the fallback and all its pending work',()=>{
  const b=boot()
  b.root.childElementCount=1;b.changed()
  expect(b.panel.remove).toHaveBeenCalledOnce()
  expect(b.disconnect).toHaveBeenCalledOnce()
  expect(b.error()).toBeUndefined()
  expect(vi.getTimerCount()).toBe(0)
})
test('recovery markup and scripts precede the module and preserve the offline shell marker',()=>{
  expect(index).toContain('<div id="root"></div>')
  expect(index.indexOf('id="app-startup"')).toBeLessThan(index.indexOf('src="/startup-v1.js"'))
  expect(index.indexOf('src="/startup-v1.js"')).toBeLessThan(index.indexOf('src="/src/main.tsx"'))
  expect(index).toContain('href="/startup-v1.css"')
})
