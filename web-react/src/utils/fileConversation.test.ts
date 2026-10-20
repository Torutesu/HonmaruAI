import {afterEach,expect,it,vi} from 'vitest'
import {openFileConversation,type FileConversationRequest} from './fileConversation'
import {hashForThread,parseRoute} from './route'
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals()})
it('opens a stable file thread through the normal thread route',async()=>{
 const target=new EventTarget();vi.stubGlobal('window',target)
 target.addEventListener('honmaru:file-conversation',event=>{
  const request=(event as CustomEvent<FileConversationRequest>).detail
  expect(request.fileId).toBe('f_'+'a'.repeat(24))
  request.resolve(hashForThread('file-thread-'+request.fileId,'personal:test'))
 })
 const hash=await openFileConversation('f_'+'a'.repeat(24))
 expect(parseRoute(hash)).toMatchObject({threadId:'file-thread-f_'+'a'.repeat(24),threadOrg:'personal:test'})
})
it('reports a missing conversation handler instead of leaving the button pending',async()=>{
 vi.useFakeTimers();vi.stubGlobal('window',new EventTarget())
 const result=expect(openFileConversation('f_'+'a'.repeat(24))).rejects.toThrow('再試行')
 await vi.advanceTimersByTimeAsync(20000)
 await result
})
