import {expect,test} from 'vitest'
import {displayLayout,fitTableColumns,SYSTEM_COLUMN_IDS,systemCellText} from './systemColumns'
const columns=[{id:'name',name:'Name',type:'text' as const},{id:'id',name:'ID',type:'text' as const}]
test('new and legacy layouts hide system fields without conflating a user ID field',()=>{
 for(const layout of [undefined,{order:['id','name'],hidden:[],widths:{name:320}}]){
  const result=displayLayout(columns,layout)
  expect(result.hidden).toEqual(SYSTEM_COLUMN_IDS)
  expect(result.order).toContain('id')
  expect(result.order).toContain('$row.id')
 }
})
test('explicitly shown metadata stays visible while title cannot be hidden',()=>{
 const result=displayLayout(columns,{order:['$row.id','name','id',...SYSTEM_COLUMN_IDS.slice(1)],hidden:['name','$row.updatedAt'],widths:{'$row.id':260}})
 expect(result.hidden).toEqual(['$row.updatedAt'])
 expect(result.order[0]).toBe('$row.id')
 expect(result.widths['$row.id']).toBe(260)
})
test('unresized table columns fill the data view while explicitly saved widths stay fixed',()=>{
 const tasks=[{id:'title',name:'Task',type:'text' as const},{id:'owner',name:'Owner',type:'person' as const},{id:'due',name:'Due',type:'date' as const},{id:'state',name:'State',type:'select' as const}]
 const fresh=fitTableColumns(tasks,{},1280)
 expect(fresh.width).toBe(1280)
 expect(fresh.widths).toEqual({title:300,owner:300,due:300,state:300})
 expect(fresh.spacerWidth).toBe(0)
 const adjusted=fitTableColumns(tasks,{title:240},1280)
 expect(adjusted.widths).toEqual({title:240,owner:320,due:320,state:320})
 const saved=fitTableColumns(tasks,{title:240,owner:180,due:180,state:180},1280)
 expect(saved.widths).toEqual({title:240,owner:180,due:180,state:180})
 expect(saved.spacerWidth).toBe(420)
})
test('system cells use row metadata rather than editable values and handle absent dates',()=>{
 const row={id:'row_real',values:{'$row.id':'spoof'},createdAt:'2026-10-18T00:00:00Z',updatedAt:'invalid'}
 expect(systemCellText(row,'$row.id')).toBe('row_real')
 expect(systemCellText(row,'$row.createdAt')).toContain('2026/10/18')
 expect(systemCellText(row,'$row.updatedAt')).toBe('—')
 expect(systemCellText({...row,createdAt:undefined},'$row.createdAt')).toBe('—')
})

test('sort cycles ascending, descending, cleared; local date inputs round-trip to UTC',async()=>{
 const {nextColumnSort,localDateTime,utcDateTime}=await import('./systemColumns')
 expect(nextColumnSort(undefined,'$row.id')).toBe('$row.id')
 expect(nextColumnSort('$row.id','$row.id')).toBe('-$row.id')
 expect(nextColumnSort('-$row.id','$row.id')).toBe('')
 const iso='2026-10-18T02:03:04.000Z'
 expect(utcDateTime(localDateTime(iso))).toBe(iso)
 expect(utcDateTime('')).toBe('')
 expect(localDateTime('invalid')).toBe('')
})
