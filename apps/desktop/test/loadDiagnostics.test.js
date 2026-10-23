import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createLoadDiagnostics } from '../src/loadDiagnostics.js'
const directories=[]
afterEach(()=>{for(const dir of directories.splice(0))rmSync(dir,{recursive:true,force:true})})
function file(){const dir=mkdtempSync(path.join(tmpdir(),'honmaru-load-'));directories.push(dir);return path.join(dir,'load.json')}
it('keeps bounded local events across restart and omits unknown fields',()=>{
 const target=file();writeFileSync(target,JSON.stringify([{at:'now',version:'1',event:'fail',code:-3,url:'https://private/?token=secret',body:'private message'}]))
 let record=createLoadDiagnostics(target,'1.3.7');record('start');record('arbitrary-secret',-1)
 expect(readFileSync(target,'utf8')).not.toMatch(/private|secret|arbitrary/)
 record=createLoadDiagnostics(target,'1.3.8');record('navigate');
 expect(JSON.parse(readFileSync(target,'utf8')).map(e=>e.event)).toEqual(['fail','start','navigate'])
 for(let i=0;i<100;i++)record('fail',-7)
 expect(JSON.parse(readFileSync(target,'utf8'))).toHaveLength(64)
})
it('does not fail loading when local diagnostic storage is unavailable or corrupt',()=>{
 const target=file();writeFileSync(target,'broken')
 expect(()=>createLoadDiagnostics(target,'test')('start')).not.toThrow()
 expect(()=>createLoadDiagnostics(path.join(target,'missing'),'test')('start')).not.toThrow()
})
it('persists only classified response and script events across restarts',()=>{
 const target=file(),record=createLoadDiagnostics(target,'next')
 record('response',403)
 record('preload-error')
 record('script-load-error')
 record('script-error')
 createLoadDiagnostics(target,'next')('start')
 const events=JSON.parse(readFileSync(target,'utf8'))
 expect(events.map(({event,code})=>({event,...(code===undefined?{}:{code})}))).toEqual([
  {event:'response',code:403},{event:'preload-error'},{event:'script-load-error'},{event:'script-error'},{event:'start'},
 ])
 expect(events.every(event=>Object.keys(event).every(key=>['at','version','event','code'].includes(key)))).toBe(true)
})
it('retains inspection outcomes and finite window flags across a restart',()=>{
 const target=file(),record=createLoadDiagnostics(target,'1.3.10')
 for(const event of ['inspect-start','inspect-visible','inspect-error','inspect-timeout','policy-error','javascript-error'])record(event)
 record('window-state',5)
 createLoadDiagnostics(target,'1.3.10')('start')
 const events=JSON.parse(readFileSync(target,'utf8'))
 expect(events.map(e=>e.event)).toEqual(['inspect-start','inspect-visible','inspect-error','inspect-timeout','policy-error','javascript-error','window-state','start'])
 expect(events.find(e=>e.event==='window-state').code).toBe(5)
})
it('retains classified native process failures without additional payload fields',()=>{
 const target=file(),record=createLoadDiagnostics(target,'next')
 record('gpu-gone',4);record('renderer-gone',5)
 createLoadDiagnostics(target,'next')('start')
 expect(JSON.parse(readFileSync(target,'utf8')).map(({event,code})=>[event,code])).toEqual([
  ['gpu-gone',4],['renderer-gone',5],['start',undefined],
 ])
})
