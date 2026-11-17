import React from 'react'
import {describe,expect,it} from 'vitest'
import {renderToStaticMarkup} from 'react-dom/server'
import {WorkspaceFindProgress} from './WorkspaceFindProgress'

const render=(step:'messages'|'resources'|'done'|'error',extra:Record<string,unknown>={})=>renderToStaticMarkup(<WorkspaceFindProgress progress={{step,...extra} as any} error="Could not finish the workspace search. Try again."/>)

describe('WorkspaceFindProgress',()=>{
 it('shows the actual current search stage on a thin accessible progress bar',()=>{
  const messages=render('messages'),resources=render('resources',{threads:2,rooms:1})
  expect(messages).toContain('Searching messages across your workspace');expect(messages).toContain('aria-valuenow="24"')
  expect(resources).toContain('2 threads across 1 Rooms');expect(resources).toContain('searching files and app records');expect(resources).toContain('aria-valuenow="72"')
 })
 it('summarizes found threads, Rooms, messages, files and app records',()=>{
  const html=render('done',{threads:3,rooms:2,messages:5,files:1,records:4})
  expect(html).toContain('3 threads across 2 Rooms');expect(html).toContain('showing 5 messages, 1 files and 4 app records');expect(html).toContain('aria-valuenow="100"')
 })
 it('announces search errors without showing a completed state',()=>{
  const html=render('error')
  expect(html).toContain('is-error');expect(html).toContain('Could not finish the workspace search');expect(html).not.toContain('role="progressbar"')
 })
})
