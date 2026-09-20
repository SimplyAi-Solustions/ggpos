/**
 * Where a notification is allowed to take somebody.
 *
 * The link comes off a server row, and a row is data, not a routing
 * instruction: `//evil.example` is a protocol-relative URL a browser would
 * happily leave the site for, and `javascript:` is worse. So only a plain
 * in-app path with exactly one leading slash is ever followed, and anything
 * else is dropped and the row renders as plain text.
 *
 * A path that does not already name a section is taken to be a portal one,
 * because that is what a notification written for a customer always is; the
 * server's own rows all start `/account/` already, so this only catches a
 * row written before that rule settled.
 */
export function portalLinkFrom(link: string | undefined): string | null {
  if (typeof link !== "string") return null
  const raw = link.trim()
  if (!raw) return null
  // One leading slash, then no backslashes, no scheme, no second slash at
  // the front, no control characters.
  if (!/^\/(?!\/)[\w\-./~%?&=+:@]*$/.test(raw)) return null
  if (raw.startsWith("/account")) return raw
  return `/account${raw}`
}
