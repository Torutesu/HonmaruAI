import React from 'react'
import {act,create} from 'react-test-renderer'
import {expect,test,vi} from 'vitest'
import {CustomAppEditor} from './CustomApp'

vi.mock('../utils/appearance',()=>({useAppearance:()=>({theme:'light'})}))
vi.mock('../utils/i18n',()=>({useT:()=>((s:string)=>s)}))

test.each([[119800,false],[119801,true]])('saved source length %s makes publish disabled=%s',async(length,disabled)=>{
 const app:any={id:'fixture',version:1,definition:{custom:{draft:'x'.repeat(length)},views:[]}},table:any={id:'table',name:'Fixture',columns:[]}
 const api:any={appDatabase:vi.fn(()=>new Promise(()=>{})),customCommitState:vi.fn().mockResolvedValue({commit:null,scope:null,approval:null}),customPublishState:vi.fn().mockResolvedValue({policy:{enabled:false},draftVersion:1,sourceHash:'hash',scope:'custom-app.publish',approval:null}),saveCustom:vi.fn(),customCommit:vi.fn(),customPublish:vi.fn(),versions:vi.fn()}
 let tree!:ReturnType<typeof create>;await act(async()=>{tree=create(<CustomAppEditor app={app} table={table} rows={[]} api={api} reload={()=>{}} httpBase="https://synthetic.invalid"/>)});
 const publish=tree.root.findAllByType('button').find(button=>button.children.join('')==='保存した下書きを公開')!
 expect(publish.props.disabled).toBe(disabled)
 if(disabled){expect(JSON.stringify(tree.toJSON())).toContain('プレビューして公開するには');act(()=>publish.props.onClick());expect(api.saveCustom).not.toHaveBeenCalled()}
 act(()=>tree.unmount())
})
