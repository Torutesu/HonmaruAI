import { readDailySetup, type DailySetup } from './dailySetup'
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
/// The last page: the three about the product, the two questions, then the daily report.
export const LAST_ONBOARDING_PAGE = 4

export function readOnboardingDraft(storage: StorageAccess, key: string): { page?: number; role?: string; locale?: string; daily?: DailySetup } {
  try {
    const value = JSON.parse(storage.getItem(`${key}:draft`) || '{}')
    if (!value || typeof value !== 'object') return {}
    const daily = readDailySetup(value.daily)
    return {
      ...(Number.isInteger(value.page) && value.page >= 0 && value.page <= LAST_ONBOARDING_PAGE ? { page: value.page } : {}),
      ...(['founder', 'operator', 'engineer', 'designer', 'member'].includes(value.role) ? { role: value.role } : {}),
      // Any language a person reads, not only the screens' five.
      ...(typeof value.locale === 'string' && /^[a-z]{2,3}$/.test(value.locale) ? { locale: value.locale } : {}),
      ...(daily ? { daily } : {}),
    }
  } catch { return {} }
}
