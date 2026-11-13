import { describe, it, expect, beforeEach, vi } from 'vitest'
import { changeLocale, localeReady, snapshot, t } from './i18n'

// A language's table arrives after it is chosen. What `useT` draws from has
// to change when it does, or React keeps what it drew in English.
describe('a language chosen before its table is here', () => {
  beforeEach(() => {
    vi.stubGlobal('document', { documentElement: {} })
    const store = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v) },
      removeItem: (k: string) => { store.delete(k) },
    })
  })

  it('repaints once the table arrives, not only when the language changes', async () => {
    changeLocale('de')
    const chosen = snapshot()
    await localeReady()
    expect(t('Saved.')).toBe('Gespeichert.')
    expect(snapshot()).not.toBe(chosen)
    changeLocale('en')
  })

  it('translates gateway contact information and formats the supplied time', async () => {
    const values: Record<string, string> = { en: 'Last contact: 12:34', ja: '最終通信: 12:34', es: 'Último contacto: 12:34', fr: 'Dernier contact : 12:34', de: 'Letzter Kontakt: 12:34' }
    try {
      for (const code of Object.keys(values)) {
        changeLocale(code)
        await localeReady()
        expect(t('Last contact: {time}', { time: '12:34' }), code).toBe(values[code])
        if (code !== 'en') {
          expect(t('No contact recorded'), code).not.toBe('No contact recorded')
          expect(t('Contact time unavailable'), code).not.toBe('Contact time unavailable')
          expect(t('The selected node is unavailable. Select another node or reload.'), code).not.toBe('The selected node is unavailable. Select another node or reload.')
          expect(t('A Mac running the user service must be awake and its user signed in. Last contact does not guarantee availability; reload to check again.'), code)
            .not.toBe('A Mac running the user service must be awake and its user signed in. Last contact does not guarantee availability; reload to check again.')
        }
      }
    } finally { changeLocale('en') }
  })

  it('translates the invite-link join confirmation (#960)', async () => {
    const messages=['Workspace invitation','Checking the invitation…','This invitation is not valid, or has expired.','{inviter} invited you to this workspace.','Joining adds you to this workspace. You stay where you are until you choose to open it.','Stay here','You already belong to this workspace.']
    try {
      for (const code of ['ja','es','fr','de']) {
        changeLocale(code); await localeReady()
        for(const message of messages) expect(t(message),code).not.toBe(message)
        for(const named of ['Join {team}?','You joined {team}.','Open {team}','An admin of {team} needs to approve you. You will be let in once they do.']) {
          expect(t(named,{team:'Acme'}),code).toContain('Acme')
          expect(t(named,{team:'Acme'}),code).not.toBe(named.replace('{team}','Acme'))
        }
      }
    } finally { changeLocale('en') }
  })

  it('translates cancellation outcomes and preserves the execution identity', async () => {
    const messages=['Execution finished before it could be cancelled.','Cancellation could not be confirmed. Reload execution history to check.','Execution history could not be refreshed. Reload to check the cancellation result.']
    try {
      for (const code of ['ja','es','fr','de']) {
        changeLocale(code); await localeReady()
        for(const message of messages) expect(t(message),code).not.toBe(message)
        expect(t('Execution {id}: {message}',{id:'job-1',message:'example'}),code).toContain('job-1')
        expect(t('Execution {id}: {message}',{id:'job-1',message:'example'}),code).toContain('example')
      }
    } finally { changeLocale('en') }
  })
})

// A hint that names a key is given the key as this keyboard prints it; a ⌘
// written into the sentence is a key most keyboards do not have.
describe('the canvas hint', () => {
  beforeEach(() => {
    vi.stubGlobal('document', { documentElement: {} })
    const store = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v) },
      removeItem: (k: string) => { store.delete(k) },
    })
  })

  it('prints the key it is handed, in every language, and none of its own', async () => {
    for (const code of ['en', 'ja', 'fr', 'de', 'es']) {
      changeLocale(code)
      await localeReady()
      const hint = t('canvas.syntax', { key: 'Ctrl+Enter' })
      expect(hint, code).toContain('Ctrl+Enter')
      expect(hint, code).not.toContain('⌘')
      expect(hint, code).not.toContain('{key}')
    }
    changeLocale('en')
  })
})
