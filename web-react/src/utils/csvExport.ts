/** A display-ready cell in a Data Viewer export. */
export interface CsvExportColumn {
  id: string
  name: string
}

export interface CsvExportRow {
  id: string
  values: Record<string, unknown>
  createdAt?: string
  updatedAt: string
}

export type CsvCellFormatter = (column: CsvExportColumn, value: unknown, row: CsvExportRow) => string

const systemValue = (row: CsvExportRow, id: string): string | undefined => {
  if (id === '$row.id') return row.id
  if (id === '$row.createdAt') return row.createdAt
  if (id === '$row.updatedAt') return row.updatedAt
  return undefined
}

/**
 * Prevent spreadsheet formula execution while retaining the displayed value.
 * Leading whitespace/control characters are considered because spreadsheet
 * applications may ignore them before interpreting a formula marker.
 */
export function neutralizeSpreadsheetFormula(value: string): string {
  return /^[\s\u0000-\u001f]*[=+\-@]/u.test(value) ? `'${value}` : value
}

function quoteCsv(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

/** Serialize rows in the supplied order, quoting every value for predictable CSV. */
export function serializeRowsToCsv(
  columns: readonly CsvExportColumn[],
  rows: readonly CsvExportRow[],
  formatCell: CsvCellFormatter = (_column, value) => value == null ? '' : typeof value === 'string' ? value : String(value),
): string {
  const header = columns.map(column => quoteCsv(column.name)).join(',')
  const body = rows.map(row => columns.map(column => {
    const system = systemValue(row, column.id)
    const raw = system !== undefined ? system : formatCell(column, row.values[column.id], row)
    return quoteCsv(neutralizeSpreadsheetFormula(raw))
  }).join(','))
  return [header, ...body].join('\r\n')
}

/** Add a UTF-8 BOM so Excel reliably detects Japanese and other Unicode text. */
export function csvDownloadContent(csv: string): string {
  return `\uFEFF${csv}`
}

/** Alias used by Data Viewer callers to emphasize this produces CSV text. */
export const csvText = serializeRowsToCsv

/** Trigger a local browser download without sending the export to a service. */
export function downloadCsv(filename: string, text: string): void {
  const blob = new Blob([csvDownloadContent(text)], {type: 'text/csv;charset=utf-8'})
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename.toLowerCase().endsWith('.csv') ? filename : `${filename}.csv`
  anchor.hidden = true
  document.body.appendChild(anchor)
  try { anchor.click() }
  finally {
    anchor.remove()
    URL.revokeObjectURL(url)
  }
}

/** Escape text for an OOXML XML part. XLSX values are written as inline strings,
 * never formulas, so user supplied values cannot become executable cells. */
function xmlText(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

function xlsxCell(ref: string, value: string): string {
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlText(value)}</t></is></c>`
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function write16(view: DataView, offset: number, value: number): void { view.setUint16(offset, value, true) }
function write32(view: DataView, offset: number, value: number): void { view.setUint32(offset, value >>> 0, true) }

/** Build a small standards-compliant XLSX in memory using uncompressed ZIP entries.
 * Inline string cells keep all displayed data literal and avoid formula injection. */
function zipStore(files: readonly {name: string; text: string}[]): Uint8Array {
  const encoder = new TextEncoder()
  const entries = files.map(file => {
    const name = encoder.encode(file.name), data = encoder.encode(file.text)
    return {name, data, crc: crc32(data)}
  })
  const localSize = entries.reduce((sum, entry) => sum + 30 + entry.name.length + entry.data.length, 0)
  const centralSize = entries.reduce((sum, entry) => sum + 46 + entry.name.length, 0)
  const result = new Uint8Array(localSize + centralSize + 22)
  let localOffset = 0, centralOffset = localSize
  for (const entry of entries) {
    let view = new DataView(result.buffer)
    write32(view, localOffset, 0x04034b50); write16(view, localOffset + 4, 20); write16(view, localOffset + 6, 0x0800)
    write16(view, localOffset + 8, 0); write32(view, localOffset + 14, entry.crc); write32(view, localOffset + 18, entry.data.length); write32(view, localOffset + 22, entry.data.length)
    write16(view, localOffset + 26, entry.name.length); write16(view, localOffset + 28, 0)
    result.set(entry.name, localOffset + 30); result.set(entry.data, localOffset + 30 + entry.name.length)
    write32(view, centralOffset, 0x02014b50); write16(view, centralOffset + 4, 20); write16(view, centralOffset + 6, 20); write16(view, centralOffset + 8, 0x0800)
    write16(view, centralOffset + 10, 0); write32(view, centralOffset + 16, entry.crc); write32(view, centralOffset + 20, entry.data.length); write32(view, centralOffset + 24, entry.data.length)
    write16(view, centralOffset + 28, entry.name.length); write16(view, centralOffset + 30, 0); write16(view, centralOffset + 32, 0); write16(view, centralOffset + 34, 0); write16(view, centralOffset + 36, 0)
    write32(view, centralOffset + 38, 0); write32(view, centralOffset + 42, localOffset)
    result.set(entry.name, centralOffset + 46)
    localOffset += 30 + entry.name.length + entry.data.length
    centralOffset += 46 + entry.name.length
  }
  const view = new DataView(result.buffer), end = centralOffset
  write32(view, end, 0x06054b50); write16(view, end + 4, 0); write16(view, end + 6, 0); write16(view, end + 8, entries.length); write16(view, end + 10, entries.length)
  write32(view, end + 12, centralSize); write32(view, end + 16, localSize); write16(view, end + 20, 0)
  return result
}

const excelColumn = (index: number): string => {
  let result = '', value = index + 1
  while (value) { value--; result = String.fromCharCode(65 + value % 26) + result; value = Math.floor(value / 26) }
  return result
}

/** Serialize the same display-ready values/order used by CSV into a minimal XLSX. */
export function serializeRowsToXlsx(
  columns: readonly CsvExportColumn[],
  rows: readonly CsvExportRow[],
  formatCell: CsvCellFormatter = (_column, value) => value == null ? '' : typeof value === 'string' ? value : String(value),
): Uint8Array {
  const allRows = [columns.map((column, index) => xlsxCell(`${excelColumn(index)}1`, column.name)), ...rows.map((row, rowIndex) => columns.map((column, index) => {
    const system = systemValue(row, column.id)
    const raw = system !== undefined ? system : formatCell(column, row.values[column.id], row)
    // XLSX cells are always strings, but prefix formula-like content consistently with CSV.
    return xlsxCell(`${excelColumn(index)}${rowIndex + 2}`, neutralizeSpreadsheetFormula(raw))
  }))]
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${allRows.map((cells, index) => `<row r="${index + 1}">${cells.join('')}</row>`).join('')}</sheetData></worksheet>`
  return zipStore([
    {name:'[Content_Types].xml',text:'<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'},
    {name:'_rels/.rels',text:'<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'},
    {name:'xl/workbook.xml',text:'<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Records" sheetId="1" r:id="rId1"/></sheets></workbook>'},
    {name:'xl/_rels/workbook.xml.rels',text:'<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'},
    {name:'xl/worksheets/sheet1.xml',text:sheet},
  ])
}

export function downloadXlsx(filename: string, bytes: Uint8Array): void {
  const ownedBytes = new Uint8Array(bytes.length)
  ownedBytes.set(bytes)
  const blob = new Blob([ownedBytes.buffer as ArrayBuffer], {type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'})
  const url = URL.createObjectURL(blob), anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename.toLowerCase().endsWith('.xlsx') ? filename : `${filename}.xlsx`
  anchor.hidden = true
  document.body.appendChild(anchor)
  try { anchor.click() }
  finally { anchor.remove(); URL.revokeObjectURL(url) }
}
