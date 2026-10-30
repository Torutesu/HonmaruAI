import React from 'react'
import { act, create } from 'react-test-renderer'
import { expect, test } from 'vitest'
import { useTranslationPreference } from './useTranslationPreference'

test('a saved enable resumes after a server-off response even when Dashboard already held true', () => {
  let value!: ReturnType<typeof useTranslationPreference>
  const Harness = ({ enabled, revision }: { enabled: boolean | null; revision: number }) => {
    value = useTranslationPreference(enabled, revision, 'same-account-workspace-session')
    return null
  }
  let tree!: ReturnType<typeof create>
  act(() => { tree = create(<Harness enabled revision={1} />) })
  const previousScope = value.scope
  act(() => { value.setServerOff(true) })
  expect(value.off).toBe(true)
  // Profile read false from the server and saved true. Dashboard's boolean
  // remains true; the successful-save revision must still unblock the chat.
  act(() => { tree.update(<Harness enabled revision={2} />) })
  expect(value.off).toBe(false)
  expect(value.scope).not.toBe(previousScope) // existing screen request effects restart
  act(() => tree.unmount())
})

test('unknown and disabled preferences gate translations; an authoritative read can re-enable the same screen', () => {
  let value!: ReturnType<typeof useTranslationPreference>
  const Harness = ({ enabled, revision }: { enabled: boolean | null; revision: number }) => {
    value = useTranslationPreference(enabled, revision, 'account')
    return null
  }
  let tree!: ReturnType<typeof create>
  act(() => { tree = create(<Harness enabled={null} revision={0} />) })
  expect(value.off).toBe(true)
  act(() => { tree.update(<Harness enabled={false} revision={1} />) })
  expect(value.off).toBe(true)
  act(() => { tree.update(<Harness enabled revision={2} />) })
  expect(value.off).toBe(false)
  act(() => tree.unmount())
})
