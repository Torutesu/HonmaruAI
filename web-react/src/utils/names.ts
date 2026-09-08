// The name a person goes by on a card.
//
// An account id carries a prefix ("u:" for the relay login, "email:" for the
// user id) and, for an email account, the whole address. None of that belongs
// on a card: the colon in it even splits a context line into a fact chip
// labelled "From u". This is the one place that turns an id into a name, so
// the feed, the list and the compose payload all agree on it.
export function displayName(login?: string): string {
  if (!login) return ''
  return String(login).replace(/^(u:|email:)/, '').split('@')[0]
}

/// The same, capitalised — for a name that starts a sentence or heads a card.
export function properName(login?: string): string {
  const name = displayName(login)
  return name ? name.charAt(0).toUpperCase() + name.slice(1) : ''
}
