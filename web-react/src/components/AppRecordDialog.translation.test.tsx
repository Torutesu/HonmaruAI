import React from 'react'
import {act,create} from 'react-test-renderer'
import {afterEach,expect,test,vi} from 'vitest'
import ja from '../utils/locales/ja'
import es from '../utils/locales/es'
import fr from '../utils/locales/fr'
import de from '../utils/locales/de'
import {AppRecordDialog,formatRecordTimestamp} from './AppRecordDialog'

const state=vi.hoisted(()=>({locale:'en',dictionary:{} as Record<string,string>}))
vi.mock('../utils/i18n',()=>({useT:()=> (key:string,values?:Record<string,string|number>)=>{
 const template=state.dictionary[key]||key
 return template.replace(/\{(\w+)\}/g,(_match,name)=>String(values?.[name]??`{${name}}`))
}}))
vi.mock('../utils/locale',()=>({getLocale:()=>state.locale}))
vi.mock('./Dialog',()=>({Dialog:({children,footer,title,lede}:any)=><section role="dialog"><h2>{title}</h2><p>{lede}</p>{children}{footer}</section>}))
afterEach(()=>{state.locale='en';state.dictionary={};vi.unstubAllGlobals()})

const dictionaries:Record<string,Record<string,string>>={en:{},ja,es,fr,de}
const expected=(key:string,locale:string)=>dictionaries[locale][key]||key

test.each(['en','ja','es','fr','de'])('localizes edit record chrome and account-locale timestamps in %s',locale=>{
 state.locale=locale;state.dictionary=dictionaries[locale]
 const record={id:'row_1',values:{},createdAt:'2026-10-18T11:00:00.000Z',updatedAt:'2026-10-19T11:00:00.000Z'}
 let tree!:ReturnType<typeof create>
 act(()=>{tree=create(<AppRecordDialog appName="Tasks" columns={[]} record={record} save={vi.fn()} onClose={()=>{}}/>)});
 expect(tree.root.findByType('h2').children.join('')).toBe(expected('Record details',locale))
 expect(tree.root.findByType('p').children.join('')).toBe('Tasks')
 expect(tree.root.findAllByType('button').map(button=>button.children.join(''))).toEqual([expected('Cancel',locale),expected('Save',locale)])
 const metadata=tree.root.findByProps({className:'hx-record-metadata'})
 expect(metadata.findAllByType('dt').map(item=>item.children.join(''))).toEqual(['ID',expected('Created',locale),expected('Updated',locale)])
 expect(metadata.findAllByType('dd').map(item=>item.children.join(''))).toEqual(['row_1',formatRecordTimestamp(record.createdAt,locale),formatRecordTimestamp(record.updatedAt,locale)])
 act(()=>tree.unmount())
})
