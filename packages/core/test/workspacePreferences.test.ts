import { describe, expect, it, vi } from 'vitest'
import { Api } from '../src/api'

describe('workspace display preference API', () => {
  it('loads the signed-in user preference in the requested workspace', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ mode: 'harness', canEdit: false, simpleOnly: true, revision: 3 }), { status: 200 }))
    const api = new Api({ base: 'https://api.example', token: () => 'session', fetch })
    await expect(api.workspaceMode('org one')).resolves.toMatchObject({ mode: 'harness', simpleOnly: true, revision: 3 })
    expect(fetch).toHaveBeenCalledWith('https://api.example/orgs/mode?orgId=org+one', { method: 'GET', headers: { 'x-session-token': 'session' }, body: undefined })
  })

  it('writes only the caller workspace preference with its expected revision', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ simpleOnly: true, revision: 4 }), { status: 200 }))
    const api = new Api({ base: 'https://api.example', token: () => 'session', fetch })
    await expect(api.setSimpleOnly('org-a', true, 3)).resolves.toEqual({ simpleOnly: true, revision: 4 })
    expect(fetch).toHaveBeenCalledWith('https://api.example/hx/display-preference', {
      method: 'PUT', headers: { 'content-type': 'application/json', 'x-session-token': 'session' },
      body: JSON.stringify({ orgId: 'org-a', simpleOnly: true, expectedRevision: 3 }),
    })
  })
})
