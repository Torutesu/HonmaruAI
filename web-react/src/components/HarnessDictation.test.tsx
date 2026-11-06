import React from 'react'
import {act,create} from 'react-test-renderer'
import {expect,test,vi} from 'vitest'
import {HarnessDictation} from './HarnessDictation'
const speech=vi.hoisted(()=>({available:true,text:(_text:string)=>{},end:(_reason?:string)=>{},stop:vi.fn(),vocabulary:[] as string[],corrections:[] as Array<{from:string;to:string}>,store:{} as Record<string,string>}))
vi.mock('../utils/i18n',()=>({useT:()=> (s:string,values?:Record<string,string>)=>values?s.replace('{word}',values.word||''):s}))
vi.mock('../utils/dictation',()=>({
 dictationAvailable:()=>speech.available,
 startDictation:(_lang:string,text:any,end:any,words:string[]=[],corrections:any[]=[])=>{speech.text=text;speech.end=end;speech.vocabulary=words;speech.corrections=corrections;return{stop:speech.stop}},
 readDictationVocabulary:(org:string,user:string)=>JSON.parse(speech.store[org+':'+user]||'[]'),
 writeDictationVocabulary:(org:string,user:string,words:string[])=>{speech.store[org+':'+user]=JSON.stringify(words);return words},
 readDictationCorrections:()=>[],
 writeDictationCorrections:(_org:string,_user:string,items:any[])=>items,
 detectDictationCorrection:(previous:string,edited:string,prefix:string)=>{const a=previous.slice(prefix.length),b=edited.slice(prefix.length);return a==='hello wor1d'&&b==='hello world'?{from:'wor1d',to:'world'}:null},
}))
test('late recognition cannot replace edited or sent drafts, or follow a room change',()=>{
 const change=vi.fn();let tree!:ReturnType<typeof create>
 const render=(value:string,key='room-a')=><HarnessDictation key={key} value={value} onChange={change} locale="ja" orgId="org" userId="user"/>
 act(()=>{tree=create(render('Hello'))})
 act(()=>tree.root.findAllByType('button')[0].props.onClick())
 act(()=>speech.text('world'));expect(change).toHaveBeenLastCalledWith('Hello world')
 act(()=>tree.update(render('Hello world')))
 act(()=>speech.text('world again'));expect(change).toHaveBeenLastCalledWith('Hello world again')
 act(()=>tree.update(render('Typed edit')))
 change.mockClear();act(()=>speech.text('late'));expect(change).not.toHaveBeenCalled()
 act(()=>tree.root.findAllByType('button')[0].props.onClick())
 act(()=>tree.update(render('')));act(()=>speech.text('after send'));expect(change).not.toHaveBeenCalled()
 act(()=>tree.root.findAllByType('button')[0].props.onClick());const old=speech.text
 act(()=>tree.update(render('another room','room-b')));act(()=>old('wrong room'));expect(change).not.toHaveBeenCalled()
 act(()=>tree.unmount())
})
test('unsupported clients have no nonfunctional microphone control',()=>{
 speech.available=false;let tree!:ReturnType<typeof create>
 try{act(()=>{tree=create(<HarnessDictation value="" onChange={vi.fn()} locale="ja" orgId="org" userId="user"/>)});expect(tree.toJSON()).toBeNull();act(()=>tree.unmount())}finally{speech.available=true}
})
test('recognition respects the composer limit and stops capturing at the boundary',()=>{
 const change=vi.fn();let tree!:ReturnType<typeof create>;speech.stop.mockClear()
 act(()=>{tree=create(<HarnessDictation value="1234" onChange={change} locale="ja" orgId="org" userId="user" maxLength={8}/>)})
 act(()=>tree.root.findAllByType('button')[0].props.onClick())
 act(()=>speech.text('567890'))
 expect(change).toHaveBeenLastCalledWith('1234 567');expect(speech.stop).toHaveBeenCalledOnce()
 change.mockClear();act(()=>speech.text('late'));expect(change).not.toHaveBeenCalled()
 expect(tree.root.findAllByType('button')[0].props['aria-pressed']).toBe(false)
 act(()=>tree.unmount())
})
test('recognition errors stop the active microphone and expose failure',()=>{
 let tree!:ReturnType<typeof create>;speech.stop.mockClear()
 act(()=>{tree=create(<HarnessDictation value="" onChange={vi.fn()} locale="ja" orgId="org" userId="user"/>)})
 act(()=>tree.root.findAllByType('button')[0].props.onClick());act(()=>speech.end('network'))
 expect(speech.stop).toHaveBeenCalledOnce();expect(tree.root.findByProps({role:'status'}).children).toContain('Voice input unavailable. Check microphone access.')
 act(()=>tree.unmount())
})
test('voice vocabulary is per user and passed to the active recognizer',()=>{
 speech.store={};speech.stop.mockClear();let tree!:ReturnType<typeof create>
 act(()=>{tree=create(<HarnessDictation value="" onChange={vi.fn()} locale="ja" orgId="org" userId="u1"/>)})
 act(()=>tree.root.findByProps({'aria-label':'Voice vocabulary'}).props.onClick())
 const input=tree.root.findByProps({'aria-label':'Add a word or phrase'})
 act(()=>input.props.onChange({target:{value:'Honmaru'}}))
 act(()=>tree.root.findByType('form').props.onSubmit({preventDefault(){}}))
 expect(speech.store['org:u1']).toBe('["Honmaru"]')
 act(()=>tree.root.findAllByType('button')[0].props.onClick())
 expect(speech.vocabulary).toEqual(['Honmaru'])
 act(()=>speech.text('welcome to honmaru'))
 act(()=>tree.unmount())
 let other!:ReturnType<typeof create>
 act(()=>{other=create(<HarnessDictation value="" onChange={vi.fn()} locale="ja" orgId="org" userId="u2"/>)})
 act(()=>other.root.findByProps({'aria-label':'Voice vocabulary'}).props.onClick())
 expect(other.root.findByProps({'aria-label':'Add a word or phrase'})).toBeTruthy()
 expect(JSON.parse(speech.store['org:u2']||'[]')).toEqual([])
 act(()=>other.unmount())
})
test('the account vocabulary loads from D1 and saves with its current revision',async()=>{
 const load=vi.fn().mockResolvedValue({vocabulary:['Remote name'],corrections:[],revision:7})
 const save=vi.fn().mockResolvedValue({vocabulary:['Remote name','New name'],corrections:[],revision:8})
 let tree!:ReturnType<typeof create>
 await act(async()=>{tree=create(<HarnessDictation value="" onChange={vi.fn()} locale="en-US" orgId="org" userId="u3" loadVocabulary={load} saveVocabulary={save}/>)})
 act(()=>tree.root.findByProps({'aria-label':'Voice vocabulary'}).props.onClick())
 expect(tree.root.findAllByType('span').some(node=>node.children.includes('Remote name'))).toBe(true)
 act(()=>tree.root.findByProps({'aria-label':'Add a word or phrase'}).props.onChange({target:{value:'New name'}}))
 await act(async()=>tree.root.findByType('form').props.onSubmit({preventDefault(){}}))
 expect(save).toHaveBeenCalledWith(['Remote name','New name'],[],7)
 expect(tree.root.findAllByType('span').some(node=>node.children.includes('New name'))).toBe(true)
 act(()=>tree.unmount())
})
test('an edited dictated name is learned as a private correction',async()=>{
 const load=vi.fn().mockResolvedValue({vocabulary:[],corrections:[],revision:4})
 const save=vi.fn().mockResolvedValue({vocabulary:[],corrections:[{from:'wor1d',to:'world'}],revision:5})
 const change=vi.fn();let tree!:ReturnType<typeof create>
 const render=(value:string)=><HarnessDictation value={value} onChange={change} locale="en-US" orgId="org" userId="u4" loadVocabulary={load} saveVocabulary={save}/>
 await act(async()=>{tree=create(render(''))})
 act(()=>tree.root.findAllByType('button')[0].props.onClick())
 act(()=>speech.text('hello wor1d'))
 await act(async()=>tree.update(render('hello world')))
 expect(save).toHaveBeenCalledWith([], [{from:'wor1d',to:'world'}], 4)
 expect(speech.stop).toHaveBeenCalled()
 act(()=>tree.unmount())
})
