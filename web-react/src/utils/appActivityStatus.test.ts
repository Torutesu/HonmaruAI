import {describe,expect,it} from 'vitest'
import {appActivityReadFailed} from './appActivityStatus'

describe('app notification partial failures', () => {
  it('does not report a channel-only request failure as an app failure', () => {
    expect(appActivityReadFailed(['m:one','r:two:a'], null)).toBe(false)
  })
  it('reports an app request failure or an explicit partial failure', () => {
    expect(appActivityReadFailed(['m:one','a:3'], null)).toBe(true)
    expect(appActivityReadFailed(['m:one'], {appActivityUnavailable:true})).toBe(true)
    expect(appActivityReadFailed(['a:3'], {})).toBe(false)
  })
})
