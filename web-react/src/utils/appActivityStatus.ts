// Ordinary channel failures should not be reported as app notification errors.
export function appActivityReadFailed(keys: string[], response: {appActivityUnavailable?: boolean} | null): boolean {
  return response?.appActivityUnavailable === true || (response === null && keys.some(key => key.startsWith('a:')))
}
