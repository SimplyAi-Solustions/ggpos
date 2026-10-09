/**
 * Staff, PINs, the lock screen's roster and manager approval
 * (docs/api-contract-epos.md, section 2).
 *
 * Three kinds of caller, and each call says which it is:
 * - **device**: the roster, PIN unlock and manager approval need this
 *   browser's till registration (`X-GG-Device`, from `lib/till-device.ts`).
 *   A PIN on its own, from an unregistered browser, opens nothing.
 * - **staff**: setting or clearing your own PIN, with a step-up token.
 * - **admin**: the staff list and everything that changes somebody else's
 *   account, each write with a step-up token.
 *
 * Demo mode answers every call from `lib/api/demo/staff.ts`, in the same
 * shapes and with the same refusal sentences, so the lock screen and the
 * approval can be walked with no server behind them.
 */
import type { Capability, OverrideGrant, Role, Roster } from "@gg/shared"

import { pb } from "@/lib/pb"
import { isDemo } from "@/lib/api/mode"
import { noteNetworkSuccess } from "@/lib/offline/net"
import { deviceHeaders } from "@/lib/till-device"
import * as demo from "@/lib/api/demo/staff"

const STEP_UP_HEADER = "X-Step-Up"

/** The record a PIN unlock signs in as: the same body a password sign-in returns. */
export interface StaffAuth {
  token: string
  record: {
    id: string
    email?: string
    name?: string
    role?: string
    active?: boolean
    must_change_password?: boolean
    [key: string]: unknown
  }
}

/** One row of `GET /api/vault/staff`. */
export interface StaffMember {
  id: string
  name: string
  email: string
  role: Role
  active: boolean
  pin_set: boolean
  pin_locked: boolean
  must_change_password: boolean
  created: string
}

export interface NewStaffInput {
  name: string
  email: string
  role: Role
  /** The temporary password: 12 characters at least, changed at first sign-in. */
  password: string
}

export interface StaffPatch {
  name?: string
  role?: Role
  active?: boolean
}

export interface OverrideRequestBody {
  capability: Capability
  approver: string
  pin: string
  context?: { sale?: string; amount?: number; reason?: string }
}

// ---------------------------------------------------------------------------
// Device calls: the lock screen and manager approval
// ---------------------------------------------------------------------------

/** Who can unlock this till: active staff, by name, with their PIN's length. */
export async function getRoster(): Promise<Roster> {
  if (isDemo()) return demo.demoRoster()
  const roster = await pb.send<Roster>("/api/vault/till/roster", {
    method: "GET",
    headers: deviceHeaders(),
  })
  noteNetworkSuccess()
  return roster
}

/**
 * Unlock with a PIN. Resolves to `{ token, record }`, which the counter
 * stores exactly as it stores a password sign-in. Every refusal is the
 * server's own sentence (`features/lock/messages.ts` reads them).
 */
export async function unlockWithPin(staffId: string, pin: string): Promise<StaffAuth> {
  if (isDemo()) return demo.demoUnlock(staffId, pin)
  return pb.send<StaffAuth>("/api/vault/till/unlock", {
    method: "POST",
    headers: deviceHeaders(),
    body: { staff: staffId, pin },
  })
}

/** A single-use approval for one capability, from a manager's PIN. */
export async function approveOverride(body: OverrideRequestBody): Promise<OverrideGrant> {
  if (isDemo()) return demo.demoOverride(body)
  return pb.send<OverrideGrant>("/api/vault/till/override", {
    method: "POST",
    headers: deviceHeaders(),
    body,
  })
}

// ---------------------------------------------------------------------------
// Your own PIN
// ---------------------------------------------------------------------------

export async function setOwnPin(pin: string, stepUpToken: string): Promise<void> {
  if (isDemo()) return demo.demoSetOwnPin(pin)
  await pb.send("/api/vault/staff/me/pin", {
    method: "POST",
    headers: { [STEP_UP_HEADER]: stepUpToken },
    body: { pin },
  })
}

export async function clearOwnPin(stepUpToken: string): Promise<void> {
  if (isDemo()) return demo.demoClearOwnPin()
  await pb.send("/api/vault/staff/me/pin", {
    method: "DELETE",
    headers: { [STEP_UP_HEADER]: stepUpToken },
  })
}

// ---------------------------------------------------------------------------
// Staff management (admin)
// ---------------------------------------------------------------------------

export async function listStaff(): Promise<StaffMember[]> {
  if (isDemo()) return demo.demoListStaff()
  const result = await pb.send<{ staff: StaffMember[] }>("/api/vault/staff", { method: "GET" })
  noteNetworkSuccess()
  return result.staff ?? []
}

export async function createStaff(input: NewStaffInput, stepUpToken: string): Promise<StaffMember> {
  if (isDemo()) return demo.demoCreateStaff(input)
  const result = await pb.send<{ staff: StaffMember }>("/api/vault/staff", {
    method: "POST",
    headers: { [STEP_UP_HEADER]: stepUpToken },
    body: input,
  })
  return result.staff
}

export async function updateStaff(
  id: string,
  patch: StaffPatch,
  stepUpToken: string
): Promise<StaffMember | null> {
  if (isDemo()) return demo.demoUpdateStaff(id, patch)
  const result = await pb.send<{ staff?: StaffMember } | StaffMember>(
    `/api/vault/staff/${encodeURIComponent(id)}`,
    { method: "PATCH", headers: { [STEP_UP_HEADER]: stepUpToken }, body: patch }
  )
  // The contract answers 200; take the member whether or not it is wrapped.
  if (result && typeof result === "object" && "staff" in result) return result.staff ?? null
  return (result as StaffMember) ?? null
}

/** A temporary password; the account has to change it at its next sign-in. */
export async function setStaffPassword(
  id: string,
  password: string,
  stepUpToken: string
): Promise<void> {
  if (isDemo()) return demo.demoSetStaffPassword(id, password)
  await pb.send(`/api/vault/staff/${encodeURIComponent(id)}/password`, {
    method: "POST",
    headers: { [STEP_UP_HEADER]: stepUpToken },
    body: { password },
  })
}

/** Somebody else's PIN; also clears their lock. */
export async function setStaffPin(id: string, pin: string, stepUpToken: string): Promise<void> {
  if (isDemo()) return demo.demoSetStaffPin(id, pin)
  await pb.send(`/api/vault/staff/${encodeURIComponent(id)}/pin`, {
    method: "POST",
    headers: { [STEP_UP_HEADER]: stepUpToken },
    body: { pin },
  })
}

export async function clearStaffPin(id: string, stepUpToken: string): Promise<void> {
  if (isDemo()) return demo.demoClearStaffPin(id)
  await pb.send(`/api/vault/staff/${encodeURIComponent(id)}/pin`, {
    method: "DELETE",
    headers: { [STEP_UP_HEADER]: stepUpToken },
  })
}
