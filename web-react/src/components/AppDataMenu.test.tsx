import React from 'react'
import {act,create} from 'react-test-renderer'
import {afterEach,expect,test,vi} from 'vitest'
import {AppDataMenu} from './AppDataMenu'
afterEach(()=>vi.unstubAllGlobals())
test('wrap toggle reports save failure and retries without falsely changing checked state',async()=>{
 vi.stubGlobal('document',{addEventListener:vi.fn(),removeEventListener:vi.fn()});const save=vi.fn().mockRejectedValueOnce(new Error('競合')).mockResolvedValue(undefined);let tree:ReturnType<typeof create>
 act(()=>{tree=create(<AppDataMenu wrapText={false} save={save}/>)});act(()=>tree!.root.findByProps({'aria-label':'その他のデータビューアー操作'}).props.onClick());await act(async()=>{tree!.root.findByProps({role:'menuitemcheckbox'}).props.onClick();await Promise.resolve()});expect(save).toHaveBeenCalledWith(true);expect(tree!.root.findByProps({role:'menuitemcheckbox'}).props['aria-checked']).toBe(false);expect(tree!.root.findByProps({role:'alert'}).children).toContain('競合');await act(async()=>{tree!.root.findByProps({role:'menuitemcheckbox'}).props.onClick();await Promise.resolve()});expect(tree!.root.findAllByProps({role:'menu'})).toHaveLength(0);act(()=>tree!.unmount())
})
