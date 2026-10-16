import { ClientResponseError } from "pocketbase"
import {
  CAPABILITY_LABELS,
  can,
  isRole,
  pinProblem,
  resolvePermissions,
  type OverrideGrant,
  type Role,
  type Roster,
} from "@gg/shared"

import { DEMO_LOCKED_STAFF, DEMO_STAFF } from "@/lib/api/fixtures"
import { DEMO_REGISTER } from "@/lib/api/demo/till-session"
import { issueDemoOverride } from "@/lib/api/demo/overrides"
import { demoSettings } from "@/lib/api/demo/settings"
import type { StaffRecord } from "@/lib/api/types"
import type {
  NewStaffInput,
  OverrideRequestBody,
  StaffAuth,
  StaffMember,
  StaffPatch,
} from "@/lib/api/staff"

/**
 * The demo counter's staff accounts.
 *
 * Demo mode has no server, so the passwords, the PINs and the
 * `must_change_password` flag live here for the page load, exactly as
 * PocketBase holds them for a real shop: a password change stops the old
 * password working, starts the new one working and clears the flag; five
 * wrong PINs lock that person's PIN until a password sign-in or an admin
 * clears it (docs/api-contract-epos.md, section 2). Nothing is persisted,
 * so a reload puts the demo back to its opening state, like the rest of the
 * fixtures.
 *
 * Three people have PINs, so the lock screen and manager approval can be
 * walked in demo mode: the demo admin, a manager and a member of staff. The
 * new starter has no PIN, which is the lock screen's "No PIN" tile.
 */

type DemoAccount = StaffRecord & { password: string }

/** A manager: approves refunds, discounts and the Z for staff. */
export const DEMO_MANAGER: DemoAccount = {
  id: "staff_demo_manager",
  email: "mo@ggentertainment.co.uk",
  password: "ggvault-manager",
  name: "Mo Khan",
  role: "manager",
  active: true,
}

/** A member of staff, whose six-digit PIN shows the longer row of dots. */
export const DEMO_MEMBER: DemoAccount = {
  id: "staff_demo_member",
  email: "sam@ggentertainment.co.uk",
  password: "ggvault-staff",
  name: "Sam Bell",
  role: "staff",
  active: true,
}

/** The PINs the demo opens with. Never shown anywhere but here and the e2e suite. */
export const DEMO_PINS: Record<string, string> = {
  [DEMO_STAFF.id]: "2580",
  [DEMO_MANAGER.id]: "1357",
  [DEMO_MEMBER.id]: "482916",
}

const SEED: DemoAccount[] = [DEMO_STAFF, DEMO_MANAGER, DEMO_MEMBER, DEMO_LOCKED_STAFF]

/** The 12 character rule, in the server's own words (pb_hooks/staff.pb.js). */
const PASSWORD_RULE =
  "Choose a password of at least 12 characters, and not the one you are using now."

const MAX_PIN_FAILURES = 5

interface Live {
  account: DemoAccount
  password: string
  mustChange: boolean
  pin: string
  failures: number
  pinLocked: boolean
  created: string
}

/** id -> the account as it stands right now. */
const state = new Map<string, Live>()

/**
 * One-time sign-in grants a PIN unlock hands back as its "token": the lock
 * passes it to the ordinary demo sign-in, which accepts it once, so a PIN
 * unlock in demo mode lands in the same session store a password sign-in
 * does.
 */
const grants = new Map<string, string>()

let sequence = 0

function reset() {
  state.clear()
  grants.clear()
  const created = new Date(Date.now() - 40 * 86_400_000).toISOString()
  for (const account of SEED) {
    state.set(account.id, {
      account: { ...account },
      password: account.password,
      mustChange: account.must_change_password === true,
      pin: DEMO_PINS[account.id] ?? "",
      failures: 0,
      pinLocked: false,
      created,
    })
  }
}
reset()

/** Puts every demo account back to its opening state. Tests only. */
export function resetDemoStaff() {
  reset()
}

function refuse(status: number, message: string): never {
  throw new ClientResponseError({
    status,
    response: { code: status, message, data: {} },
  })
}

function byEmail(email: string): Live | undefined {
  const clean = email.trim().toLowerCase()
  for (const live of state.values()) {
    if (live.account.email === clean) return live
  }
  return undefined
}

function record(live: Live): StaffRecord {
  const { password: _password, ...rest } = live.account
  void _password
  return { ...rest, must_change_password: live.mustChange }
}

/** The server's rule: first and last words' first letters, or a one-word name's first two. */
function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return ""
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase()
  return `${parts[0]![0]}${parts[parts.length - 1]![0]}`.toUpperCase()
}

/** Whoever the demo session says is signed in. */
function signedInId(): string | null {
  try {
    const raw = localStorage.getItem("gg-demo-staff")
    return raw ? ((JSON.parse(raw) as { id?: string }).id ?? null) : null
  } catch {
    return null
  }
}

function member(live: Live): StaffMember {
  return {
    id: live.account.id,
    name: live.account.name,
    email: live.account.email,
    role: live.account.role,
    active: live.account.active !== false,
    pin_set: live.pin !== "",
    pin_locked: live.pinLocked,
    must_change_password: live.mustChange,
    created: live.created,
  }
}

// ---------------------------------------------------------------------------
// Passwords
// ---------------------------------------------------------------------------

/**
 * The account that signs in with this email and password, or null. A
 * password sign-in clears the PIN's failures and lock, as the server does.
 */
export function demoSignIn(email: string, password: string): StaffRecord | null {
  const live = byEmail(email)
  if (!live || live.account.active === false) return null
  const grant = grants.get(password)
  if (grant === live.account.id) {
    // A PIN unlock's one-time grant: not a password, so it clears nothing.
    grants.delete(password)
    return record(live)
  }
  if (live.password !== password) return null
  live.failures = 0
  live.pinLocked = false
  return record(live)
}

/** Confirms a password without signing in. Used by the password lock. */
export function demoPasswordMatches(email: string, password: string): boolean {
  return byEmail(email)?.password === password
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
  const live = byEmail(email)
  if (!live || live.password !== current) return null
  live.password = next
  live.mustChange = false
  return record(live)
}

// ---------------------------------------------------------------------------
// The roster, PIN unlock and manager approval
// ---------------------------------------------------------------------------

export function demoRoster(): Roster {
  const staff = [...state.values()]
    .filter((live) => live.account.active !== false)
    .sort((a, b) => a.account.name.localeCompare(b.account.name))
    .map((live) => ({
      id: live.account.id,
      name: live.account.name,
      initials: initialsOf(live.account.name),
      role: live.account.role,
      pin_set: live.pin !== "",
      pin_length: live.pin.length,
      pin_locked: live.pinLocked,
    }))
  return { register: { ...DEMO_REGISTER }, staff }
}

/** The PIN check unlock and approval share, with the server's sentences. */
function checkPin(live: Live, pin: string): void {
  if (live.account.active === false) {
    refuse(403, "This account is inactive. Ask an admin to reactivate it.")
  }
  if (!live.pin) {
    refuse(409, `${live.account.name} has no PIN yet. Sign in with a password to set one.`)
  }
  if (live.pinLocked) {
    refuse(
      423,
      "Too many wrong PINs. Sign in with your password, or ask an admin to reset your PIN."
    )
  }
  if (live.pin === pin) {
    live.failures = 0
    return
  }
  live.failures += 1
  if (live.failures >= MAX_PIN_FAILURES) {
    live.pinLocked = true
    refuse(
      423,
      "Too many wrong PINs. Sign in with your password, or ask an admin to reset your PIN."
    )
  }
  const left = MAX_PIN_FAILURES - live.failures
  refuse(401, `That PIN is not right. ${left} ${left === 1 ? "try" : "tries"} left.`)
}

export function demoUnlock(staffId: string, pin: string): StaffAuth {
  if (!staffId) refuse(400, "Choose your name first.")
  if (!pin) refuse(400, "Key your PIN.")
  const live = state.get(staffId)
  if (!live) refuse(404, "That member of staff was not found. Choose your name again.")
  checkPin(live, pin)
  sequence += 1
  const token = `demo-pin-grant-${sequence}-${Math.random().toString(36).slice(2, 10)}`
  grants.set(token, live.account.id)
  return { token, record: { ...record(live), collectionName: "staff" } }
}

export function demoOverride(body: OverrideRequestBody): OverrideGrant {
  if (!body.approver) refuse(400, "Choose who is approving this.")
  if (!body.pin) refuse(400, "Key the approver's PIN.")
  const approver = state.get(body.approver)
  if (!approver) refuse(404, "That member of staff was not found. Choose your name again.")
  if (body.capability === "settings_manage" || body.capability === "staff_manage") {
    refuse(403, "That needs an admin signed in.")
  }
  if (approver.account.id === signedInId()) {
    refuse(403, "You cannot approve your own request. Ask somebody else to key their PIN.")
  }
  const table = resolvePermissions(demoSettings().epos?.permissions)
  if (!can(approver.account.role, body.capability, table)) {
    const label = CAPABILITY_LABELS[body.capability]
    refuse(
      403,
      `${approver.account.name} cannot approve that. Ask somebody who can ${label.charAt(0).toLowerCase()}${label.slice(1)}.`
    )
  }
  checkPin(approver, body.pin)
  sequence += 1
  const token = `demo-override-${sequence}-${Math.random().toString(36).slice(2, 10)}`
  issueDemoOverride(token, body.capability, approver.account.id)
  return {
    token,
    capability: body.capability,
    approver: { id: approver.account.id, name: approver.account.name },
    expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
  }
}

// ---------------------------------------------------------------------------
// PINs
// ---------------------------------------------------------------------------

function setPin(live: Live, pin: string) {
  const problem = pinProblem(pin)
  if (problem) refuse(400, problem)
  live.pin = pin
  live.failures = 0
  live.pinLocked = false
}

export function demoSetOwnPin(pin: string): void {
  const live = state.get(signedInId() ?? "")
  if (!live) refuse(401, "Sign in again, then set your PIN.")
  setPin(live, pin)
}

export function demoClearOwnPin(): void {
  const live = state.get(signedInId() ?? "")
  if (!live) refuse(401, "Sign in again, then clear your PIN.")
  live.pin = ""
  live.failures = 0
  live.pinLocked = false
}

// ---------------------------------------------------------------------------
// Staff management
// ---------------------------------------------------------------------------

export function demoListStaff(): StaffMember[] {
  return [...state.values()]
    .sort((a, b) => a.account.name.localeCompare(b.account.name))
    .map(member)
}

function activeAdmins(except?: string): number {
  return [...state.values()].filter(
    (live) =>
      live.account.id !== except &&
      live.account.role === "admin" &&
      live.account.active !== false
  ).length
}

export function demoCreateStaff(input: NewStaffInput): StaffMember {
  const name = input.name.trim()
  const email = input.email.trim().toLowerCase()
  if (!name) refuse(400, "Give them a name.")
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    refuse(400, "That is not an email address. Check it and try again.")
  }
  if (!isRole(input.role)) refuse(400, "Choose a role: staff, manager or admin.")
  if (input.password.length < 12) refuse(400, PASSWORD_RULE)
  if (byEmail(email)) refuse(409, "Somebody already uses that email.")
  sequence += 1
  const live: Live = {
    account: {
      id: `staff_demo_added_${sequence}`,
      email,
      password: input.password,
      name,
      role: input.role,
      active: true,
    },
    password: input.password,
    mustChange: true,
    pin: "",
    failures: 0,
    pinLocked: false,
    created: new Date().toISOString(),
  }
  state.set(live.account.id, live)
  return member(live)
}

export function demoUpdateStaff(id: string, patch: StaffPatch): StaffMember {
  const live = state.get(id)
  if (!live) refuse(404, "That member of staff was not found.")
  const nextRole: Role = patch.role ?? live.account.role
  const nextActive = patch.active ?? live.account.active !== false
  const stillAdmin = nextRole === "admin" && nextActive
  if (live.account.role === "admin" && live.account.active !== false && !stillAdmin) {
    if (activeAdmins(id) === 0) refuse(409, "There has to be at least one active admin.")
  }
  if (patch.name !== undefined) {
    const name = patch.name.trim()
    if (!name) refuse(400, "Give them a name.")
    live.account.name = name
  }
  live.account.role = nextRole
  live.account.active = nextActive
  return member(live)
}

export function demoSetStaffPassword(id: string, password: string): void {
  const live = state.get(id)
  if (!live) refuse(404, "That member of staff was not found.")
  if (password.length < 12 || password === live.password) refuse(400, PASSWORD_RULE)
  live.password = password
  live.mustChange = true
}

export function demoSetStaffPin(id: string, pin: string): void {
  const live = state.get(id)
  if (!live) refuse(404, "That member of staff was not found.")
  setPin(live, pin)
}

export function demoClearStaffPin(id: string): void {
  const live = state.get(id)
  if (!live) refuse(404, "That member of staff was not found.")
  live.pin = ""
  live.failures = 0
  live.pinLocked = false
}
