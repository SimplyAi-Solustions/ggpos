/**
 * Which paths are My Vault (the customer side): /account, /c/ share pages and
 * /estimate, exactly the set pb/pb_hooks/appshell.pb.js serves account.html
 * for. The inline script in index.html carries the same test so the
 * `gg-customer` class and the dark default apply before first paint; keep
 * the two in step.
 */
export function isCustomerPath(pathname: string): boolean {
  return (
    pathname === "/account" ||
    pathname.startsWith("/account/") ||
    pathname === "/c" ||
    pathname.startsWith("/c/") ||
    pathname === "/estimate" ||
    pathname.startsWith("/estimate/")
  )
}

/** True when the current page is a customer page. */
export function onCustomerPage(): boolean {
  return typeof window !== "undefined" && isCustomerPath(window.location.pathname)
}
