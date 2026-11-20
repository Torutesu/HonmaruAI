import React from 'react'
import { act, create } from 'react-test-renderer'
import { afterEach, expect, test, vi } from 'vitest'
import { CustomAppEditor } from './CustomApp'
import { changeLocale, loadLocale, t } from '../utils/i18n'

afterEach(() => { changeLocale('en'); vi.unstubAllGlobals() })

function stubLocaleStorage() {
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) || null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  })
}

test('custom app editor chrome follows every supported screen locale', async () => {
  stubLocaleStorage()
  const app = { id: 'app', version: 1, definition: { custom: { draft: '' } } } as any
  const table = { id: 'table', name: 'Tasks', columns: [] } as any
  const tree = create(<CustomAppEditor app={app} table={table} rows={[]} api={{} as any} reload={() => {}} httpBase="https://api.example" />)
  const titleByLocale: Record<string, string> = {
    en: 'Custom app', ja: 'カスタムアプリ', es: 'Aplicación personalizada', fr: 'Application personnalisée', de: 'Benutzerdefinierte App',
  }
  for (const [locale, title] of Object.entries(titleByLocale)) {
    await act(async () => {
      changeLocale(locale)
      await loadLocale(locale)
    })
    expect(t('Custom app')).toBe(title)
    expect(tree.root.findByType('h2').children.join('')).toBe(title)
  }
  act(() => tree.unmount())
})

test('saved-code replacement confirmation uses the selected locale', async () => {
  stubLocaleStorage()
  const expected: Record<string, string> = {
    en: 'Discard your edits and use the currently saved code?',
    ja: '編集中のコードを破棄して、現在保存されているコードを使いますか？',
    es: '¿Descartar tus cambios y usar el código guardado actualmente?',
    fr: 'Abandonner vos modifications et utiliser le code actuellement enregistré ?',
    de: 'Deine Änderungen verwerfen und den aktuell gespeicherten Code verwenden?',
  }
  const confirm = vi.fn(() => false)
  vi.stubGlobal('window', { confirm, addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn() })
  const table = { id: 'table', name: 'Tasks', columns: [] } as any
  const api = {} as any
  for (const [locale, prompt] of Object.entries(expected)) {
    await act(async () => { changeLocale(locale); await loadLocale(locale) })
    const app = { id: `app-${locale}`, version: 1, definition: { custom: { draft: '<p>old</p>' } } } as any
    const tree = create(<CustomAppEditor app={app} table={table} rows={[]} api={api} reload={() => {}} httpBase="https://api.example" />)
    const source = tree.root.findByProps({ 'aria-label': t('Custom app source') })
    act(() => source.props.onChange({ target: { value: '<p>local edit</p>' } }))
    await act(async () => {
      tree.update(<CustomAppEditor app={{ ...app, definition: { custom: { draft: '<p>remote update</p>' } } }} table={table} rows={[]} api={api} reload={() => {}} httpBase="https://api.example" />)
      await Promise.resolve()
    })
    const useSaved = tree.root.findAllByType('button').find(button => button.children.join('') === t('Use saved code'))!
    act(() => useSaved.props.onClick())
    expect(confirm).toHaveBeenLastCalledWith(prompt)
    act(() => tree.unmount())
  }
})
