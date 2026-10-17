import React from 'react'
import {act,create} from 'react-test-renderer'
import {afterEach,expect,test,vi} from 'vitest'
import {useAppPins} from './appPins'
afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers()})
test('pins refresh on focus and timer, and never display the previous authenticated scope',async()=>{
  vi.useFakeTimers()
  const events=new EventTarget(), documentEvents=new EventTarget()
  vi.stubGlobal('window',Object.assign(events,{setInterval,clearInterval}))
  vi.stubGlobal('document',Object.assign(documentEvents,{visibilityState:'visible'}))
  let result:ReturnType<typeof useAppPins>
  const api={appPins:vi.fn().mockResolvedValue({pins:['one']}),setAppPin:vi.fn().mockResolvedValue({pins:[]})}
  function Probe({source=api}:{source?:typeof api}){result=useAppPins('org',source);return <span>{result.pins.join(',')}</span>}
  let tree:ReturnType<typeof create>
  await act(async()=>{tree=create(<Probe/>)});
  expect(result!.pins).toEqual(['one'])
  api.appPins.mockResolvedValue({pins:['two']})
  await act(async()=>{events.dispatchEvent(new Event('focus'))})
  expect(result!.pins).toEqual(['two'])
  api.appPins.mockResolvedValue({pins:['three']})
  await act(async()=>{vi.advanceTimersByTime(30000)})
  expect(result!.pins).toEqual(['three'])
  const other={...api,appPins:vi.fn().mockReturnValue(new Promise(()=>{}))}
  act(()=>tree!.update(<Probe source={other}/>))
  expect(result!.pins).toEqual([])
  act(()=>tree!.unmount())
})
