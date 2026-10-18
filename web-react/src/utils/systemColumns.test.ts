import {expect,test} from 'vitest'
import {displayLayout,SYSTEM_COLUMN_IDS,systemCellText} from './systemColumns'
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
