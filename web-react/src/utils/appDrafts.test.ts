import {afterEach,expect,test,vi} from 'vitest'
import {appDrafts} from './appDrafts'
afterEach(()=>vi.unstubAllGlobals())
function storage(){const values=new Map([['sessionToken','token'],['userId','alice']]);const store={getItem:(k:string)=>values.get(k)||null,setItem:(k:string,v:string)=>values.set(k,v),removeItem:(k:string)=>values.delete(k)};vi.stubGlobal('localStorage',store);return store}
test('restores drafts by account, server, workspace, app and record without storing credentials',()=>{
 const store=storage(),draft=appDrafts('https://api','org','token');draft.write('app text','a');draft.write('record text','a','table','row')
 expect(appDrafts('https://api','org','token').read('a')).toBe('app text');expect(draft.read('a','table','row')).toBe('record text')
 for(const [base,org,app,table,row] of [['https://other','org','a'],['https://api','other','a'],['https://api','org','other'],['https://api','org','a','table','other']])expect(appDrafts(base,org,'token').read(app,table,row)).toBe('')
 store.setItem('userId','bob');expect(draft.read('a')).toBe('');draft.write('wrong','a');expect(appDrafts('https://api','org','token').read('a')).toBe('')
 store.setItem('userId','alice');expect(draft.read('a')).toBe('app text');draft.write('','a');expect(draft.read('a')).toBe('')
})
test('restores annotation metadata beside its draft and isolates it by app and record',()=>{
 storage();const draft=appDrafts('https://api','org','token'),marker={target:'Status column',x:22.5,y:74,section:'data' as const}
 draft.write('Please update this field','app');draft.writeAnnotation(marker,'app')
 expect(appDrafts('https://api','org','token').readAnnotation('app')).toEqual(marker)
 expect(draft.readAnnotation('other')).toBeNull();expect(draft.readAnnotation('app','table','row')).toBeNull()
 draft.writeAnnotation({target:'bad',x:101,y:5,section:'data'},'app');expect(draft.readAnnotation('app')).toBeNull()
 draft.writeAnnotation(marker,'app','table','row');expect(draft.readAnnotation('app','table','row')).toEqual(marker)
})
test('stale sessions and inaccessible storage never leak or break editing',()=>{
 const store=storage(),draft=appDrafts('api','org','token');draft.write('saved','a');store.setItem('sessionToken','new');draft.write('stale','a');expect(draft.read('a')).toBe('');expect(appDrafts('api','org','new').read('a')).toBe('saved')
 vi.stubGlobal('localStorage',{getItem(){throw Error('blocked')}});expect(()=>appDrafts('api','org','new').write('text','a')).not.toThrow();expect(draft.read('a')).toBe('')
})
