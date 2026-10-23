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
