/**
 * Where to go after sign-in. Only a path on this site is accepted, so a
 * crafted link cannot bounce a fresh session to another origin.
 */
export function safeRedirect(target: unknown, fallback = "/scan"): string {
  if (typeof target !== "string") return fallback
  if (!target.startsWith("/") || target.startsWith("//") || target.startsWith("/\\")) return fallback
  if (target === "/login" || target.startsWith("/login?") || target === "/") return fallback
  return target
}
