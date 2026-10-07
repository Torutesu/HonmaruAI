import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import {desktopNotificationsEnabled,setDesktopNotificationsEnabled,enableDesktopNotifications,testDesktopNotification} from './desktopNotifications'
let values:Map<string,string>
let shown = vi.fn<(...args: unknown[]) => void>()
beforeEach(()=>{
 values=new Map();shown=vi.fn()
 vi.stubGlobal('localStorage',{getItem:(key:string)=>values.get(key)||null,setItem:(key:string,value:string)=>values.set(key,value)})
 vi.stubGlobal('window',Object.assign(new EventTarget(),{honmaruDesktop:{isDesktop:true,platform:'darwin',show:vi.fn()}}))
 class N {static permission='granted';static requestPermission=vi.fn().mockResolvedValue('granted');onclick=null;constructor(...args:unknown[]){shown(...args)}close(){}}
 vi.stubGlobal('Notification',N)
})
afterEach(()=>vi.unstubAllGlobals())
it('starts off, persists the explicit choice, and can be switched off',async()=>{
 expect(desktopNotificationsEnabled()).toBe(false)
 expect(await enableDesktopNotifications()).toBe(true)
 expect(desktopNotificationsEnabled()).toBe(true)
 setDesktopNotificationsEnabled(false);expect(desktopNotificationsEnabled()).toBe(false)
})
it('does not call a request accepted by the OS a delivered notification',()=>{
 setDesktopNotificationsEnabled(true);testDesktopNotification();expect(shown).toHaveBeenCalledOnce()
})
it('does not enable notifications when permission is denied',async()=>{
 Object.defineProperty(Notification,'permission',{value:'denied'})
 vi.mocked(Notification.requestPermission).mockResolvedValue('denied')
 expect(await enableDesktopNotifications()).toBe(false);expect(desktopNotificationsEnabled()).toBe(false)
})
it('does not send a test while notifications are off',()=>{
 expect(()=>testDesktopNotification()).toThrow();expect(shown).not.toHaveBeenCalled()
})

it('delivers replies only after opt-in and closes a withdrawn request on the desktop', async () => {
 const {notifyDecisionReply, notifyNewDecision, closeCardNotifications} = await import('./notifications')
 vi.stubGlobal('document', {visibilityState:'hidden', documentElement:{}})
 const close=vi.fn()
 class N {static permission='granted';onclick=null;onclose=null;constructor(...args:unknown[]){shown(...args)}close=close}
 vi.stubGlobal('Notification',N)
 notifyDecisionReply('Budget','reply-test','org-test');expect(shown).not.toHaveBeenCalled()
 setDesktopNotificationsEnabled(true)
 notifyDecisionReply('Budget','reply-test','org-test');expect(shown).toHaveBeenCalledOnce()
 expect(shown.mock.calls[0][1]).toMatchObject({data:{kind:'decided',cardId:'reply-test',orgId:'org-test',hash:'#/feed/reply-test/org-test'}})
 notifyNewDecision('Request','Colleague','request-test','org-test')
 closeCardNotifications(['request-test']);expect(close).toHaveBeenCalledOnce()
})

it('keeps desktop banners but silences them when sound is off', async () => {
 const {notifyNewDecision} = await import('./notifications')
 const {saveSoundSettings, DEFAULT_SOUNDS} = await import('./sound')
 vi.stubGlobal('document', {visibilityState:'hidden', documentElement:{}})
 setDesktopNotificationsEnabled(true)
 saveSoundSettings({...DEFAULT_SOUNDS, enabled:false})
 notifyNewDecision('Request','Colleague','silent-request','org-test')
 expect(shown).toHaveBeenCalledOnce()
 expect(shown.mock.calls[0][1]).toMatchObject({silent:true,data:{cardId:'silent-request'}})
 shown.mockClear()
 testDesktopNotification()
 expect(shown.mock.calls[0][1]).toMatchObject({silent:true})
})
