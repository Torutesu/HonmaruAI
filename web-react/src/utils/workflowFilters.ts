import type {Column, ConditionScalar} from './harness'

// The server accepts a scalar or a list for every flat predicate. Resolve a
// field name the same way as the server: IDs are exact and names ignore case.
export type FilterValue = ConditionScalar | ConditionScalar[]
export type FilterMap = Record<string, FilterValue>
const resolvedColumn = (columns: Column[], key: string) => columns.find(candidate => candidate.id === key || candidate.name.toLowerCase() === key.toLowerCase())
export function filterKeysForColumn(where: FilterMap | undefined, columns: Column[], column: Column) {
  return Object.keys(where || {}).filter(key => resolvedColumn(columns,key)?.id === column.id)
}
export function unresolvedFilterKeys(where: FilterMap | undefined, columns: Column[]) {
  return Object.keys(where || {}).filter(key => !resolvedColumn(columns,key))
}
export function newFilterKey(columns: Column[], column: Column) {
  // A previous column name can shadow a later column ID. Never write a key
  // unless the Worker would resolve it back to the selected column.
  return [column.id,column.name].find(key => resolvedColumn(columns,key)?.id === column.id)
}
export function filterValueText(value: FilterValue, separator = ' / ') {
  return Array.isArray(value) ? value.length ? value.map(String).join(separator) : '[]' : String(value)
}

// A key may be a column ID or an alias. The worker resolves both by the
// first matching column, and multiple aliases are separate AND predicates.
export function hasRemovedFilter(original: FilterMap | undefined, current: FilterMap | undefined, columns: Column[] = []) {
  const counts = (where: FilterMap | undefined) => {
    const result = new Map<string, number>()
    for (const key of Object.keys(where || {})) {
      const index = columns.findIndex(column => column.id === key || column.name.toLowerCase() === key.toLowerCase())
      const identity = index < 0 ? `key:${key}` : `column:${index}`
      result.set(identity, (result.get(identity) || 0) + 1)
    }
    return result
  }
  const before = counts(original), after = counts(current)
  return [...before].some(([identity,count]) => (after.get(identity) || 0) < count)
}
