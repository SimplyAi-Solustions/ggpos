/**
 * What the staff list says about each person, in words, so status never
 * rests on a colour or an icon (DESIGN.md section 9). Pure, for the tests.
 */
import { ROLE_LABELS, type Role } from "@gg/shared"

import type { StaffMember } from "@/lib/api/staff"

export function roleWord(role: Role): string {
  return ROLE_LABELS[role] ?? role
}

/** "Set", "Locked" after five wrong tries, or "None". */
export function pinWord(member: Pick<StaffMember, "pin_set" | "pin_locked">): string {
  if (member.pin_locked) return "Locked"
  return member.pin_set ? "Set" : "None"
}

export function statusWord(member: Pick<StaffMember, "active">): string {
  return member.active ? "Active" : "Inactive"
}

/** The grey line under a name on a phone, and the password column on a desktop. */
export function passwordWord(member: Pick<StaffMember, "must_change_password">): string {
  return member.must_change_password ? "Must change password" : ""
}

/** One line summing a person up for the phone list. */
export function summaryLine(member: StaffMember): string {
  return [
    roleWord(member.role),
    member.active ? "" : "inactive",
    `PIN ${pinWord(member).toLowerCase()}`,
    member.must_change_password ? "must change password" : "",
  ]
    .filter(Boolean)
    .join(", ")
}

/** The 12 character rule, said before anything is sent (pb_hooks/staff.pb.js). */
export const MIN_PASSWORD = 12

export function passwordProblem(password: string): string | null {
  if (password.length < MIN_PASSWORD) {
    return "A temporary password is at least 12 characters. They choose their own at first sign-in."
  }
  return null
}

export function emailProblem(email: string): string | null {
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) {
    return "That is not an email address. Check it and try again."
  }
  return null
}
