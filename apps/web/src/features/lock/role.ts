/**
 * The signed-in member's role, as the permissions table ranks it.
 *
 * `useStaff()` hands back the session `lib/auth.ts` keeps, and that module
 * still folds every role it does not know into "staff", which reads a
 * manager as a member of staff. Until it learns the manager role (a request
 * in the lock package's report), the role is read here from the SDK's own
 * auth record live, and from the demo session in demo mode, so a manager
 * gets the Tills settings and is offered as an approver.
 */
import { isRole, type Role } from "@gg/shared"

import { pb } from "@/lib/pb"
import { isDemo } from "@/lib/api/mode"
import { useStaff } from "@/lib/auth"
import type { StaffRecord } from "@/lib/api/types"

export function roleOf(staff: StaffRecord | null | undefined): Role | null {
  if (!staff) return null
  if (!isDemo()) {
    const record = pb.authStore.record
    if (record && record.id === staff.id && isRole(record.role)) return record.role
  }
  return isRole(staff.role) ? staff.role : null
}

/** Re-renders with the session, so a user switch at the lock moves it. */
export function useStaffRole(): Role | null {
  return roleOf(useStaff())
}

/** A manager or an admin: who may register a device or see the Tills settings. */
export function isManagerUp(role: Role | null): boolean {
  return role === "manager" || role === "admin"
}
