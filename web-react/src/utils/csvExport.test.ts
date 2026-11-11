import {describe, expect, it} from 'vitest'
import {csvDownloadContent, neutralizeSpreadsheetFormula, serializeRowsToCsv} from './csvExport'

const cols = [{id:'name',name:'名前'},{id:'note',name:'メモ'}]
const row = (name:unknown,note:unknown) => ({id:'r1',updatedAt:'2026-10-01T00:00:00Z',values:{name,note}})

describe('serializeRowsToCsv',()=>{
  it('quotes Unicode, commas, double quotes, and line breaks',()=>{
    expect(serializeRowsToCsv(cols,[row('青,空','彼は"OK"と言った\n次の行')])).toBe(
      '"名前","メモ"\r\n"青,空","彼は""OK""と言った\n次の行"',
    )
  })

  it('neutralizes formula-leading cells, including leading whitespace',()=>{
    expect(serializeRowsToCsv(cols,[row('=1+1','  \t@SUM(A1:A2)')])).toBe(
      '"名前","メモ"\r\n"\'=1+1","\'  \t@SUM(A1:A2)"',
    )
  })

  it('maps system fields and leaves empty values empty',()=>{
    const csv=serializeRowsToCsv([
      {id:'$row.id',name:'ID'}, {id:'$row.createdAt',name:'作成日時'},
      {id:'$row.updatedAt',name:'更新日時'}, {id:'missing',name:'空'},
    ],[row(null,null)])
    expect(csv).toBe('"ID","作成日時","更新日時","空"\r\n"r1","","2026-10-01T00:00:00Z",""')
  })

  it('returns only a header for an empty result and no trailing newline',()=>{
    expect(serializeRowsToCsv(cols,[])).toBe('"名前","メモ"')
  })

  it('preserves input row order and supports a relation display formatter',()=>{
    const rows=[row('second','person-2'),{...row('first','person-1'),id:'r2'}]
    const csv=serializeRowsToCsv(cols,rows,(_column,value)=>value==='person-1'?'花子':value==='person-2'?'太郎':String(value??''))
    expect(csv).toBe('"名前","メモ"\r\n"second","太郎"\r\n"first","花子"')
  })
})

describe('neutralizeSpreadsheetFormula',()=>{
  it.each(['=1','+1','-1','@SUM(1)','\t=1','\r@x'])('prefixes %j',value=>{
    expect(neutralizeSpreadsheetFormula(value)).toBe(`'${value}`)
  })
  it.each(['text =1','1+1','abc',''])('leaves safe text %j unchanged',value=>{
    expect(neutralizeSpreadsheetFormula(value)).toBe(value)
  })
})

it('adds a UTF-8 BOM for download content',()=>{
  expect(csvDownloadContent('"名前"')).toBe('\uFEFF"名前"')
})
