// An explicit workspace link never borrows the selected workspace's scope.
export function conversationScope(selected: string | null, linked: string | null, orgs?: readonly { id: string }[]): string | null {
  if (!linked) return selected
  return orgs?.some((org) => org.id === linked) && selected === linked ? linked : null
}
