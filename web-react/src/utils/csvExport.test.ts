import {describe, expect, it} from 'vitest'
import {csvDownloadContent, neutralizeSpreadsheetFormula, serializeRowsToCsv, serializeRowsToXlsx} from './csvExport'

const cols = [{id:'name',name:'名前'},{id:'note',name:'メモ'}]
const row = (name:unknown,note:unknown) => ({id:'r1',updatedAt:'2026-10-01T00:00:00Z',values:{name,note}})
function xlsxSheet(bytes:Uint8Array):string {
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),decoder=new TextDecoder()
  for(let offset=0;offset+30<bytes.length;){
    if(view.getUint32(offset,true)!==0x04034b50)break
    const size=view.getUint32(offset+18,true),nameSize=view.getUint16(offset+26,true),extraSize=view.getUint16(offset+28,true)
    const name=decoder.decode(bytes.subarray(offset+30,offset+30+nameSize)),start=offset+30+nameSize+extraSize
    if(name==='xl/worksheets/sheet1.xml')return decoder.decode(bytes.subarray(start,start+size))
    offset=start+size
  }
  throw new Error('XLSX sheet not found')
}

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

  it('neutralizes formula-leading column names as well as record cells',()=>{
    expect(serializeRowsToCsv([
      {id:'name',name:'=HYPERLINK("x")'},
      {id:'note',name:'  @SUM(A1:A2)'},
    ],[row('literal','value')])).toBe(
      '"\'=HYPERLINK(""x"")","\'  @SUM(A1:A2)"\r\n"literal","value"',
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

describe('serializeRowsToXlsx',()=>{
  it('writes ordered display values, Unicode, relation labels, system columns, and literal formulas',()=>{
    const bytes=serializeRowsToXlsx([
      {id:'$row.id',name:'ID'}, {id:'customer',name:'顧客'}, {id:'name',name:'名前'},
      {id:'$row.createdAt',name:'作成日時'}, {id:'$row.updatedAt',name:'更新日時'},
    ],[{...row('=HYPERLINK("x")',''),createdAt:'2026-09-30T00:00:00Z',values:{name:'=HYPERLINK("x")',customer:'customer-1'}}],(_column,value)=>value==='customer-1'?'株式会社あおい':String(value??''))
    const output=xlsxSheet(bytes),archiveText=new TextDecoder().decode(bytes)
    expect([...bytes.slice(0,4)]).toEqual([0x50,0x4b,0x03,0x04])
    expect(archiveText).toContain('[Content_Types].xml')
    expect(archiveText).toContain('sheet1.xml')
    expect(output).toContain('顧客')
    expect(output).toContain('株式会社あおい')
    expect(output).toContain('2026-09-30T00:00:00Z')
    expect(output).toContain('2026-10-01T00:00:00Z')
    expect(output).toContain('&apos;=HYPERLINK(&quot;x&quot;)')
    expect(output).not.toContain('<f>')
  })

  it('escapes XML metacharacters, strips forbidden controls, and supports an empty table',()=>{
    const bytes=serializeRowsToXlsx([{id:'note',name:'備考'}],[{...row('',''),values:{note:'A&B<\u0001"'}}])
    const output=xlsxSheet(bytes)
    expect(output).toContain('A&amp;B&lt;&quot;')
    expect(output).not.toContain('\u0001')
    expect(output).not.toContain('<f>')
    expect(new TextDecoder().decode(serializeRowsToXlsx(cols,[]))).toContain('名前')
  })
})
