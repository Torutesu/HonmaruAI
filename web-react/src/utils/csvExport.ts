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
