import { expect, test } from 'vitest'
import { monthDays, shiftMonth } from './AppCalendar'

test('calendar month boundaries are stable across leap years and year changes', () => {
  expect(monthDays('2028-02').filter(Boolean)).toHaveLength(29)
  expect(monthDays('2027-02').filter(Boolean)).toHaveLength(28)
  expect(monthDays('2026-10')[4]).toBe('2026-10-01')
  expect(shiftMonth('2026-12', 1)).toBe('2027-01')
  expect(shiftMonth('2026-01', -1)).toBe('2025-12')
})

import React from 'react'
import { act, create } from 'react-test-renderer'
import { vi } from 'vitest'
import { AppCalendar } from './AppCalendar'
vi.mock('../utils/i18n', () => ({ useT: () => (text: string) => text }))

test('calendar displays dated and undated records and sends date edits to the caller', () => {
  const onMove = vi.fn(), onOpen = vi.fn()
  const dated = { id: 'r1', values: { name: 'Invoice', due: '2028-02-29' }, updatedAt: '' }
  const undated = { id: 'r2', values: { name: 'Draft' }, updatedAt: '' }
  let tree: ReturnType<typeof create>
  act(() => { tree = create(<AppCalendar view={{ id: 'v', type: 'calendar', name: 'Calendar', dateColumn: 'due', days: [{ date: '2028-02-29', rows: [dated] }], undated: [undated] }} table={{ id: 't', name: 'Tasks', columns: [{ id: 'name', name: 'Name', type: 'text' }, { id: 'due', name: 'Due', type: 'date' }] }} onMove={onMove} onOpen={onOpen} />) })
  act(() => tree!.root.findByProps({ type: 'month' }).props.onChange({ target: { value: '2028-02' } }))
  expect(JSON.stringify(tree!.toJSON())).toContain('Invoice')
  expect(JSON.stringify(tree!.toJSON())).toContain('Draft')
  act(() => tree!.root.findAllByProps({ type: 'date' })[0].props.onChange({ target: { value: '2028-03-01' } }))
  expect(onMove).toHaveBeenCalledWith(dated, '2028-03-01')
  act(()=>tree!.root.findByProps({'aria-label':'Invoiceの詳細を開く'}).props.onClick())
  expect(onOpen).toHaveBeenCalledWith(dated)
  act(()=>tree!.root.findByProps({'aria-label':'Draftの詳細を開く'}).props.onClick())
  expect(onOpen).toHaveBeenLastCalledWith(undated)
  act(() => tree!.unmount())
})

test('calendar formats titles without an open action and keeps preferring text columns', () => {
  const row = {id:'r',values:{customer:'id-1',name:'Invoice'},updatedAt:''}
  const format = vi.fn((_column, value) => String(value).toUpperCase())
  let tree: ReturnType<typeof create>
  act(()=>{tree=create(<AppCalendar view={{id:'v',type:'calendar',name:'Calendar',dateColumn:'due',undated:[row]}} table={{id:'t',name:'Tasks',columns:[{id:'customer',name:'Customer',type:'relation',targetEntity:'customers'},{id:'name',name:'Name',type:'text'},{id:'due',name:'Due',type:'date'}]}} onMove={vi.fn()} displayCellText={format}/>)})
  expect(tree!.root.findByProps({className:'hx-card-title'}).children).toEqual(['INVOICE'])
  expect(format).toHaveBeenCalledWith(expect.objectContaining({id:'name'}),'Invoice')
  act(()=>tree!.unmount())
})
