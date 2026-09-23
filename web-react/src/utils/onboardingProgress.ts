type StorageAccess = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
export const onboardingKey = (api: string, user: string) => `onboarding:${api}:${user}`
export function needsOnboarding(storage: StorageAccess, api: string, user: string, created = false): boolean {
  try {
    const key = onboardingKey(api, user)
    if (storage.getItem(`${key}:complete`) === 'yes') return false
    if (created) storage.setItem(`${key}:pending`, 'yes')
    return created || storage.getItem(`${key}:pending`) === 'yes'
  } catch { return created }
}
export function completeOnboarding(storage: StorageAccess, api: string, user: string): void {
  try {
    const key = onboardingKey(api, user)
    storage.setItem(`${key}:complete`, 'yes')
    storage.removeItem(`${key}:pending`)
    storage.removeItem(`${key}:draft`)
  } catch { /* In-memory completion can still proceed. */ }
}
export function readOnboardingDraft(storage: StorageAccess, key: string): { page?: number; role?: string; locale?: string } {
  try {
    const value = JSON.parse(storage.getItem(`${key}:draft`) || '{}')
    if (!value || typeof value !== 'object') return {}
    return {
      ...(Number.isInteger(value.page) && value.page >= 0 && value.page <= 3 ? { page: value.page } : {}),
      ...(['founder', 'operator', 'engineer', 'designer', 'member'].includes(value.role) ? { role: value.role } : {}),
      ...(['en', 'ja', 'es', 'fr', 'de'].includes(value.locale) ? { locale: value.locale } : {}),
    }
  } catch { return {} }
}
