import { beforeEach, describe, expect, it } from 'vitest'
import { completeOnboarding, needsOnboarding, onboardingKey, readOnboardingDraft } from './onboardingProgress'
const values = new Map<string, string>()
const storage = { getItem: (key: string) => values.get(key) || null, setItem: (key: string, value: string) => { values.set(key, value) }, removeItem: (key: string) => { values.delete(key) } }
beforeEach(() => values.clear())
describe('account scoped onboarding', () => {
  it('resumes an unfinished signup without forcing returning accounts', () => {
    expect(needsOnboarding(storage, 'api', 'existing')).toBe(false)
    storage.setItem('onboarded', 'yes')
    expect(needsOnboarding(storage, 'api', 'new', true)).toBe(true)
    expect(needsOnboarding(storage, 'api', 'new')).toBe(true)
    expect(needsOnboarding(storage, 'different-api', 'new')).toBe(false)
    expect(needsOnboarding(storage, 'api', 'other')).toBe(false)
    completeOnboarding(storage, 'api', 'new')
    expect(needsOnboarding(storage, 'api', 'new', true)).toBe(false)
  })
  it('restores a valid draft and clears it only after completion', () => {
    const key = onboardingKey('api', 'new')
    storage.setItem(`${key}:draft`, JSON.stringify({ page: 3, role: 'engineer', locale: 'de' }))
    expect(readOnboardingDraft(storage, key)).toEqual({ page: 3, role: 'engineer', locale: 'de' })
    completeOnboarding(storage, 'api', 'new')
    expect(readOnboardingDraft(storage, key)).toEqual({})
  })
  it('rejects corrupt and unsupported saved answers', () => {
    const key = onboardingKey('api', 'new')
    storage.setItem(`${key}:draft`, JSON.stringify({ page: 999, role: 'admin', locale: 'invalid' }))
    expect(readOnboardingDraft(storage, key)).toEqual({})
    storage.setItem(`${key}:draft`, 'broken')
    expect(readOnboardingDraft(storage, key)).toEqual({})
  })
})
