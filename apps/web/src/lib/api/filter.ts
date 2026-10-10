/**
 * The one place a value is escaped before it goes into a PocketBase filter.
 *
 * PocketBase's filter syntax is a string, so a name with a quote in it, or a
 * search box somebody has pasted a backslash into, has to be escaped before
 * it is concatenated in. Every module that builds a filter imports this
 * rather than keeping a copy: six copies of the same three characters is six
 * places for one of them to drift.
 */
export function escapeFilter(value: string): string {
  return value.replace(/["\\]/g, "\\$&")
}
