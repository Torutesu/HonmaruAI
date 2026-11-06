import React from 'react'
import { act, create } from 'react-test-renderer'
import { expect, test, vi } from 'vitest'
import { AppViewportPreview } from './AppViewportPreview'
import { DatabaseAppPreview } from './DatabaseAppPreview'
import type { App, Row, Table } from '../utils/harness'

const app={id:'app',name:'Requests',icon:'📋',description:'Team requests',definition:{views:[]}} as unknown as App
const table={id:'table',name:'Requests',columns:[{id:'name',name:'Request',type:'text'},{id:'status',name:'Status',type:'text'}]} as Table
const rows=[{id:'r1',updatedAt:'2026-11-06T00:00:00.000Z',values:{name:'Laptop for design',status:'Approved'}}] as Row[]

test('shows populated database rows in desktop table and phone cards',()=>{
  const tree=create(<AppViewportPreview><DatabaseAppPreview app={app} table={table} rows={rows}/></AppViewportPreview>)
  const desktop=tree.root.findByProps({'aria-label':'デスクトップ表示'})
  const phone=tree.root.findByProps({'aria-label':'モバイル表示'})
  expect(desktop.props['aria-pressed']).toBe(true)
  expect(tree.root.findByProps({className:'hx-database-preview-table'}).findAllByType('tr')).toHaveLength(2)
  expect(JSON.stringify(tree.toJSON())).toContain('Approved')
  act(()=>phone.props.onClick())
  expect(tree.root.findByProps({'data-viewport':'phone'})).toBeTruthy()
  expect(tree.root.findByProps({className:'hx-database-preview-card-title'}).children.join('')).toBe('Laptop for design')
  expect(tree.root.findByProps({className:'hx-database-preview-mobile'}).findAllByType('article')).toHaveLength(1)
})

test('shows an explicit empty state and opens the data viewer',()=>{
  const onBrowseData=vi.fn()
  const tree=create(<AppViewportPreview><DatabaseAppPreview app={app} table={table} rows={[]} onBrowseData={onBrowseData}/></AppViewportPreview>)
  expect(tree.root.findAllByProps({className:'hx-database-preview-empty'})).toHaveLength(2)
  const browse=tree.root.findByProps({'aria-label':'データを開く'})
  act(()=>browse.props.onClick())
  expect(onBrowseData).toHaveBeenCalledTimes(1)
  const phone=tree.root.findByProps({'aria-label':'モバイル表示'})
  act(()=>phone.props.onClick())
  expect(tree.root.findByProps({'data-viewport':'phone'})).toBeTruthy()
})
