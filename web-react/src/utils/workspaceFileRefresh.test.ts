import {expect,test,vi} from 'vitest'
import {subscribeWorkspaceFileRefresh} from './workspaceFileRefresh'
test('file updates reconnect and focus refresh once per burst; teardown cancels pending work',()=>{
 vi.useFakeTimers()
 try{
  const target=new EventTarget(),refresh=vi.fn(),dispose=subscribeWorkspaceFileRefresh(refresh,target)
  const send=(name:string)=>target.dispatchEvent(new CustomEvent('honmaru:jam',{detail:{name}}))
  send('jam_offer');vi.advanceTimersByTime(200);expect(refresh).not.toHaveBeenCalled()
  send('workspace_files_changed');send('workspace_files_changed');send('reset');vi.advanceTimersByTime(150);expect(refresh).toHaveBeenCalledTimes(1)
  target.dispatchEvent(new Event('focus'));vi.advanceTimersByTime(150);expect(refresh).toHaveBeenCalledTimes(2)
  send('workspace_files_changed');dispose();vi.advanceTimersByTime(200);send('reset');target.dispatchEvent(new Event('focus'));vi.advanceTimersByTime(200);expect(refresh).toHaveBeenCalledTimes(2)
 }finally{vi.useRealTimers()}
})
