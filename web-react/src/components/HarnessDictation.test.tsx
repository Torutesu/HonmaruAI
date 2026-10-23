import React from 'react'
import {act,create} from 'react-test-renderer'
import {expect,test,vi} from 'vitest'
import {HarnessDictation} from './HarnessDictation'
const speech=vi.hoisted(()=>({available:true,text:(_text:string)=>{},end:(_reason?:string)=>{},stop:vi.fn()}))
vi.mock('../utils/i18n',()=>({useT:()=> (s:string)=>s}))
vi.mock('../utils/dictation',()=>({dictationAvailable:()=>speech.available,startDictation:(_lang:string,text:any,end:any)=>{speech.text=text;speech.end=end;return{stop:speech.stop}}}))
test('late recognition cannot replace edited or sent drafts, or follow a room change',()=>{
 const change=vi.fn();let tree!:ReturnType<typeof create>
 const render=(value:string,key='room-a')=><HarnessDictation key={key} value={value} onChange={change} locale="ja"/>
 act(()=>{tree=create(render('Hello'))})
 act(()=>tree.root.findByType('button').props.onClick())
 act(()=>speech.text('world'));expect(change).toHaveBeenLastCalledWith('Hello world')
 act(()=>tree.update(render('Hello world')))
 act(()=>speech.text('world again'));expect(change).toHaveBeenLastCalledWith('Hello world again')
 act(()=>tree.update(render('Typed edit')))
 change.mockClear();act(()=>speech.text('late'));expect(change).not.toHaveBeenCalled()
 act(()=>tree.root.findByType('button').props.onClick())
 act(()=>tree.update(render('')));act(()=>speech.text('after send'));expect(change).not.toHaveBeenCalled()
 act(()=>tree.root.findByType('button').props.onClick());const old=speech.text
 act(()=>tree.update(render('another room','room-b')));act(()=>old('wrong room'));expect(change).not.toHaveBeenCalled()
 act(()=>tree.unmount())
})
test('unsupported clients have no nonfunctional microphone control',()=>{
 speech.available=false;let tree!:ReturnType<typeof create>
 try{act(()=>{tree=create(<HarnessDictation value="" onChange={vi.fn()} locale="ja"/>)});expect(tree.toJSON()).toBeNull();act(()=>tree.unmount())}finally{speech.available=true}
})
test('recognition respects the composer limit and stops capturing at the boundary',()=>{
 const change=vi.fn();let tree!:ReturnType<typeof create>;speech.stop.mockClear()
 act(()=>{tree=create(<HarnessDictation value="1234" onChange={change} locale="ja" maxLength={8}/>)})
 act(()=>tree.root.findByType('button').props.onClick())
 act(()=>speech.text('567890'))
 expect(change).toHaveBeenLastCalledWith('1234 567');expect(speech.stop).toHaveBeenCalledOnce()
 change.mockClear();act(()=>speech.text('late'));expect(change).not.toHaveBeenCalled()
 expect(tree.root.findByType('button').props['aria-pressed']).toBe(false)
 act(()=>tree.unmount())
})
test('recognition errors stop the active microphone and expose failure',()=>{
 let tree!:ReturnType<typeof create>;speech.stop.mockClear()
 act(()=>{tree=create(<HarnessDictation value="" onChange={vi.fn()} locale="ja"/>)})
 act(()=>tree.root.findByType('button').props.onClick());act(()=>speech.end('network'))
 expect(speech.stop).toHaveBeenCalledOnce();expect(tree.root.findByProps({role:'status'}).children).toContain('Voice input unavailable. Check microphone access.')
 act(()=>tree.unmount())
})
