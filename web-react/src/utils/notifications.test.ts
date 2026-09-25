import { describe, it, expect, beforeEach, vi } from 'vitest'
import { notifyNewDecision, setNotificationCopy } from './notifications'
import { changeLocale } from './i18n'

// A tab's own notification, in the reader's language even when the page has
// no table for it: the Worker wrote the words and /me carried them.
describe('in-tab notification', () => {
  const shown: Array<{ title: string; body: string }> = []
  beforeEach(() => {
    shown.length = 0
    class FakeNotification {
      static permission = 'granted'
      constructor(title: string, options: { body: string }) { shown.push({ title, body: options.body }) }
    }
    vi.stubGlobal('Notification', FakeNotification)
    vi.stubGlobal('document', { visibilityState: 'hidden', documentElement: {} })
    const store = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v) },
      removeItem: (k: string) => { store.delete(k) },
    })
  })

  it('uses the Worker’s words for a language the page cannot speak', () => {
    changeLocale('vi')
    setNotificationCopy({ locale: 'vi', newDecision: 'Bạn có quyết định mới', from: 'Từ {name}' })
    notifyNewDecision('Phê duyệt ngân sách', 'Mai')
    expect(shown[0]).toEqual({ title: 'Bạn có quyết định mới', body: 'Phê duyệt ngân sách\nTừ Mai' })
  })

  it('does not use words written for a language no longer being read', () => {
    changeLocale('ja')
    setNotificationCopy({ locale: 'vi', newDecision: 'Bạn có quyết định mới', from: 'Từ {name}' })
    notifyNewDecision('予算の承認', 'Mai')
    expect(shown[0]).toEqual({ title: '新しい決定が届きました', body: '予算の承認\nMaiから' })
  })
})
