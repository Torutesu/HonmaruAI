import React from 'react'
import {renderToStaticMarkup} from 'react-dom/server'
import {expect, test} from 'vitest'
import {SidebarSavedState} from './SidebarSavedState'

test('shows saved channel order and whether each saved section is folded', () => {
  const sidebar = {
    starred:['b:cafe'],
    order:['b:front','b:cafe'],
    sections:[{id:'a',name:'仕事',views:['b:cafe'],collapsed:true},{id:'b',name:'連絡',views:[],collapsed:false}],
  }
  const names:Record<string,string>={'b:front':'受付','b:cafe':'カフェ'}
  const html=renderToStaticMarkup(<SidebarSavedState sidebar={sidebar} nameOf={view=>names[view]||view} japanese />)
  expect(html).toContain('サーバー上の固定:')
  expect(html).toContain('サーバー上のチャンネル順:')
  expect(html).toContain('受付, カフェ')
  expect(html).toContain('仕事 (折りたたみ): カフェ')
  expect(html).toContain('連絡 (展開中): —')
})

test('labels an unset order and section states in English', () => {
  const html=renderToStaticMarkup(<SidebarSavedState sidebar={{starred:[],sections:[{id:'a',name:'Work',views:['b:team'],collapsed:true}]}} nameOf={view=>view} japanese={false} />)
  expect(html).toContain('Saved channel order:')
  expect(html).toContain('Default order')
  expect(html).toContain('Work (Collapsed): b:team')
})
