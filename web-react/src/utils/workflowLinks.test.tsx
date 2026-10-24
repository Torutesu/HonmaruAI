import React from 'react'
import {expect,test} from 'vitest'
import {renderToStaticMarkup} from 'react-dom/server'
import {parseWorkflowLink} from './workflowLinks'
import {renderRich} from '../components/MessageParts'
const html=(text:string)=>renderToStaticMarkup(<div>{renderRich(text,()=> 'mention')}</div>)
test('generated workflow results render escaped names as an in-app link',()=>{
 const text='[請求 \\[確認\\]](#/workflows/wf_one/team%3Aone) を作成しました。'
 expect(parseWorkflowLink(text.split(' を')[0])).toMatchObject({id:'wf_one',orgId:'team:one',label:'請求 [確認]'})
 expect(html(text)).toContain('href="#/workflows/wf_one/team%3Aone"')
 expect(html(text)).toContain('請求 [確認]</a>')
 expect(html(text)).not.toContain('target="_blank"')
})
test('only exact workflow routes become internal links',()=>{
 for(const target of ['javascript:alert(1)','https://evil.test/#/workflows/wf_one/team%3Aone','/workflows/wf_one/team%3Aone','#/workflows/wf_one','#/workflows/%3Cbad%3E/team%3Aone','#/workflows/wf_one/team%3Aone/extra','#/workflows/wf_one/%00','#/workflows/wf_one/team%3Aone?edit=1'])expect(parseWorkflowLink(`[Open](${target})`)).toBeNull()
 expect(html('[Open](#/workflows/%3Cbad%3E/team%3Aone)')).not.toContain('<a')
})
test('code blocks retain literal workflow links and app links still render',()=>{
 expect(html('```\n[Open](#/workflows/wf_one/team%3Aone)\n```')).not.toContain('<a')
 expect(html('[Tracker](#/apps/app_one/team%3Aone)')).toContain('href="#/apps/app_one/team%3Aone"')
})
