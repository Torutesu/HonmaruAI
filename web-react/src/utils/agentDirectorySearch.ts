import type { Mentionable } from './mentions'

const normalize = (value: string) => value.normalize('NFKC').trim().toLocaleLowerCase()

export function agentMatchesDirectoryQuery(agent: { name: string; handle?: string | null; specialty?: string | null }, query: string) {
  const needle = normalize(query)
  if (!needle) return true
  return [agent.name, agent.handle || '', agent.specialty || ''].some(value => normalize(value).includes(needle))
}

export function memberMatchesDirectoryQuery(member: Mentionable, query: string) {
  const needle = normalize(query)
  if (!needle) return true
  return [member.name, member.handle || '', ...(member.aliases || [])].some(value => normalize(value).includes(needle))
}
