// The team's own agents: "@hayao" answers in a thread as its Markdown says.
//
// The Worker keeps them (worker/src/customAgents.js); this is what the
// browser needs to show, edit and bring them back as files.

export interface ClientAgent {
  id: string
  handle: string
  name: string
  emoji: string | null
  description: string
  instructions: string
  scope: 'team' | 'personal'
  preset: string | null
  createdBy: string | null
  createdByName: string | null
  mine: boolean
  updatedByName: string | null
  updatedAt: string
  canEdit: boolean
  canDelete: boolean
  /// The agent as a .md file, ready to download.
  markdown: string
}

export interface AgentPreset {
  id: string
  handle: string
  emoji: string
  name: string
  description: string
  instructions: string
}

/// What the editor holds: a new agent, a preset being added, or one being changed.
export interface AgentDraft {
  id: string | null
  name: string
  handle: string
  emoji: string
  description: string
  instructions: string
  scope: 'team' | 'personal'
  preset: string | null
  /// Only its maker moves an agent between the team and themself.
  canChangeScope: boolean
}

export const MAX_INSTRUCTIONS = 20000

export const blankDraft = (scope: 'team' | 'personal' = 'team'): AgentDraft => ({
  id: null, name: '', handle: '', emoji: '', description: '', instructions: '', scope, preset: null, canChangeScope: true,
})

export const draftFromPreset = (p: AgentPreset): AgentDraft => ({
  id: null, name: p.name, handle: p.handle, emoji: p.emoji, description: p.description, instructions: p.instructions,
  scope: 'team', preset: p.id, canChangeScope: true,
})

export const draftFromAgent = (a: ClientAgent): AgentDraft => ({
  id: a.id, name: a.name, handle: a.handle, emoji: a.emoji || '', description: a.description || '', instructions: a.instructions,
  scope: a.scope, preset: a.preset, canChangeScope: a.mine,
})

const FIELDS = ['name', 'handle', 'emoji', 'description', 'scope']

/// A .md file as an agent, the way the Worker reads one: front matter for
/// its name and face, the rest its instructions; no front matter, and the
/// first heading names it. Used to put a file the server refused (its
/// @name is taken, say) into the editor, so it can be fixed and saved.
export function parseAgentFile(text: string): AgentDraft {
  const src = String(text || '').replace(/^﻿/, '').replace(/\r\n?/g, '\n')
  const out: Record<string, string> = {}
  let body = src
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(src)
  if (m) {
    body = src.slice(m[0].length)
    for (const line of m[1].split('\n')) {
      const kv = /^\s*([A-Za-z_]+)\s*:\s*(.*)$/.exec(line)
      if (!kv) continue
      const key = kv[1].toLowerCase()
      if (!FIELDS.includes(key)) continue
      out[key] = kv[2].trim().replace(/^(["'])(.*)\1$/, '$2')
    }
  }
  if (!out.name) {
    const heading = /^#\s+(.+)$/m.exec(body)
    if (heading) out.name = heading[1].trim()
  }
  return {
    id: null,
    name: out.name || '',
    handle: (out.handle || '').replace(/^[@＠]+/, ''),
    emoji: out.emoji || '',
    description: out.description || '',
    instructions: body.trim(),
    scope: out.scope === 'personal' ? 'personal' : 'team',
    preset: null,
    canChangeScope: true,
  }
}

/// The Worker's refusals, in the reader's language where they are known.
export function agentError(message: string, t: (key: string, vars?: Record<string, string | number>) => string): string {
  const msg = String(message || '').trim()
  if (!msg) return t('That did not save.')
  const named = /^@(\S+) is already (somebody's name here|a group|an agent here)\.$/.exec(msg)
  if (named) {
    const [, handle, what] = named
    if (what === 'a group') return t('@{handle} is already a group. Try another @name.', { handle })
    if (what === 'an agent here') return t('@{handle} is already an agent here. Try another @name.', { handle })
    return t('@{handle} is already somebody’s name here. Try another @name.', { handle })
  }
  return t(msg)
}

/// "hayao.md": a name to save the file under.
export const agentFileName = (handle: string) => `${String(handle || 'agent').replace(/[^\p{L}\p{N}_.-]/gu, '') || 'agent'}.md`
