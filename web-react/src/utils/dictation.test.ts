import {afterEach,expect,test,vi} from 'vitest'
import {applyDictationVocabulary,detectDictationCorrection,readDictationVocabulary,writeDictationVocabulary,startDictation} from './dictation'

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

test('vocabulary is bounded, deduplicated, editable, and scoped to the account',()=>{
 expect(writeDictationVocabulary('a',[' Honmaru ','Honmaru','Product Ops'])).toEqual(['Honmaru','Product Ops'])
 expect(readDictationVocabulary('a')).toEqual(['Honmaru','Product Ops'])
 expect(readDictationVocabulary('b')).toEqual([])
 expect(writeDictationVocabulary('a',['  '])).toEqual([])
 expect(readDictationVocabulary('a')).toEqual([])
})

test('longer phrases are applied first and regex characters are treated literally',()=>{
 expect(applyDictationVocabulary('honmaru and product ops', ['Honmaru','Product Ops'])).toBe('Honmaru and Product Ops')
 expect(applyDictationVocabulary('call ops.v2 now', ['ops.v2'])).toBe('call ops.v2 now')
 expect(applyDictationVocabulary('the wor1d is ready', [], [{from:'wor1d',to:'world'}])).toBe('the world is ready')
 expect(applyDictationVocabulary('swordfish', [], [{from:'word',to:'name'}])).toBe('swordfish')
})

test('learns only a single token correction within the dictated suffix',()=>{
 expect(detectDictationCorrection('Hello wor1d','Hello world','Hello ')).toEqual({from:'wor1d',to:'world'})
 expect(detectDictationCorrection('Hello wor1d','Changed wor1d','Hello ')).toBeNull()
 expect(detectDictationCorrection('本丸に行く','本丸へ行く','','ja')).toEqual({from:'に',to:'へ'})
 expect(detectDictationCorrection('今日会議','明日開始','','ja')).toBeNull()
})

test('private vocabulary is normalized locally without passing phrase hints to the browser',()=>{
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
 expect(instance.phrases).toEqual([])
 instance.onresult({resultIndex:0,results:[Object.assign([ {transcript:'honmaru is ready'} ],{isFinal:false})]})
 expect(changed).toHaveBeenLastCalledWith('Honmaru is ready',false)
 // The composer can submit this interim value immediately; no onend/final event is required.
 handle.stop()
})
