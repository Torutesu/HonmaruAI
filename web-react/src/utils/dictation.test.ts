import {afterEach,expect,test,vi} from 'vitest'
import {applyDictationVocabulary,readDictationVocabulary,writeDictationVocabulary,startDictation} from './dictation'

const memory = new Map<string,string>()
const storage = {
 getItem:(key:string)=>memory.get(key)??null,
 setItem:(key:string,value:string)=>{memory.set(key,String(value))},
 removeItem:(key:string)=>{memory.delete(key)},
 clear:()=>memory.clear(),
}
;(globalThis as any).localStorage=storage
;(globalThis as any).window=(globalThis as any).window||{}
afterEach(()=>{storage.clear();delete (window as any).SpeechRecognition;delete (window as any).webkitSpeechRecognition})

test('vocabulary is bounded, deduplicated, editable, and scoped to organization and user',()=>{
 expect(writeDictationVocabulary('org','a',[' Honmaru ','Honmaru','Product Ops'])).toEqual(['Honmaru','Product Ops'])
 expect(readDictationVocabulary('org','a')).toEqual(['Honmaru','Product Ops'])
 expect(readDictationVocabulary('org','b')).toEqual([])
 expect(readDictationVocabulary('other','a')).toEqual([])
 expect(writeDictationVocabulary('org','a',['  '])).toEqual([])
 expect(readDictationVocabulary('org','a')).toEqual([])
})

test('longer phrases are applied first and regex characters are treated literally',()=>{
 expect(applyDictationVocabulary('honmaru and product ops', ['Honmaru','Product Ops'])).toBe('Honmaru and Product Ops')
 expect(applyDictationVocabulary('call ops.v2 now', ['ops.v2'])).toBe('call ops.v2 now')
})

test('browser phrase hints and normalized interim text are available without delaying sends',()=>{
 let instance:any, onText:(text:string,final:boolean)=>void=()=>{}
 class FakeRecognition {
   lang='';continuous=false;interimResults=false;phrases:any[]=[]
   onresult:any=null;onend:any=null;onerror:any=null
   start(){instance=this}
   stop(){}
 }
 ;(window as any).SpeechRecognition=FakeRecognition
 const changed=vi.fn((text:string,final:boolean)=>{onText(text,final)})
 const handle=startDictation('en-US',changed,()=>{},['Honmaru'])!
 expect(instance.phrases).toEqual([{phrase:'Honmaru',boost:5}])
 instance.onresult({resultIndex:0,results:[Object.assign([ {transcript:'honmaru is ready'} ],{isFinal:false})]})
 expect(changed).toHaveBeenLastCalledWith('Honmaru is ready',false)
 // The composer can submit this interim value immediately; no onend/final event is required.
 handle.stop()
})
