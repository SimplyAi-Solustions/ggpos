import { DEMO_LOCKED_STAFF, DEMO_STAFF } from "@/lib/api/fixtures"
import type { StaffRecord } from "@/lib/api/types"

/**
 * The demo counter's staff accounts.
 *
 * Demo mode has no server, so the password and the `must_change_password`
 * flag live here for the page load, exactly as PocketBase holds them for a
 * real shop: a password change stops the old password working, starts the
 * new one working and clears the flag. Nothing is persisted, so a reload
 * puts the demo back to its opening state, like the rest of the fixtures.
 */

type DemoAccount = StaffRecord & { password: string }

const ACCOUNTS: DemoAccount[] = [DEMO_STAFF, DEMO_LOCKED_STAFF]

/** email -> the password that signs in right now, and whether it is locked. */
const state = new Map<string, { password: string; locked: boolean }>()

function reset() {
  state.clear()
  for (const account of ACCOUNTS) {
    state.set(account.email, {
      password: account.password,
      locked: account.must_change_password === true,
    })
  }
}
reset()

/** Puts every demo account back to its opening state. Tests only. */
export function resetDemoStaff() {
  reset()
}

function record(account: DemoAccount): StaffRecord {
  const live = state.get(account.email)
  const { password: _password, ...rest } = account
  void _password
  return { ...rest, must_change_password: live?.locked === true }
}

/** The account that signs in with this email and password, or null. */
export function demoSignIn(email: string, password: string): StaffRecord | null {
  const clean = email.trim().toLowerCase()
  const account = ACCOUNTS.find((entry) => entry.email === clean)
  if (!account) return null
  if (state.get(clean)?.password !== password) return null
  return record(account)
}

/** Confirms a password without signing in. Used by the idle lock. */
export function demoPasswordMatches(email: string, password: string): boolean {
  return state.get(email.trim().toLowerCase())?.password === password
}

/**
 * Changes a demo account's password. Returns the account as it is
 * afterwards, unlocked, or null when the current password is wrong.
 */
export function demoChangePassword(
  email: string,
  current: string,
  next: string
): StaffRecord | null {
  const clean = email.trim().toLowerCase()
  const account = ACCOUNTS.find((entry) => entry.email === clean)
  const live = state.get(clean)
  if (!account || !live || live.password !== current) return null
  state.set(clean, { password: next, locked: false })
  return record(account)
}
