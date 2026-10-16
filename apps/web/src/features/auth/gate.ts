import type { StaffRecord } from "@/lib/api/types"

/**
 * The counter's password gate.
 *
 * A staff account created for somebody else, with a password somebody else
 * chose, carries `must_change_password` until that person sets one of their
 * own. While it is set the counter shows nothing but `/counter/password`:
 * the guard below is what every `/counter` route asks, and the shell asks
 * the same question before it draws any chrome.
 *
 * Pure on purpose, so the rule can be unit-tested without a router, a
 * server or a rendered screen.
 */

/** The one screen a locked account may see. */
export const PASSWORD_PATH = "/counter/password"

/**
 * Twelve, not PocketBase's own eight. The counter PC is shared and its
 * password is typed in front of customers. Kept in step with the same
 * number in `pb/pb_hooks/staff.pb.js`, which is what actually enforces it.
 */
export const MIN_PASSWORD_LENGTH = 12

/** Said the same way by the server and by the screen, so neither surprises. */
export const PASSWORD_REFUSAL =
  "Choose a password of at least 12 characters, and not the one you are using now."

export function isLocked(staff: StaffRecord | null | undefined): boolean {
  return staff?.must_change_password === true
}

/**
 * Where a locked staff member belongs, or null when they are already there
 * or are not locked at all. `pathname` is the path being visited, without
 * the query string.
 */
export function lockedRedirect(
  staff: StaffRecord | null | undefined,
  pathname: string
): string | null {
  if (!isLocked(staff)) return null
  // Trailing slashes and nested paths under the screen itself all count as
  // being on it, so the guard can never bounce the screen into itself.
  if (pathname === PASSWORD_PATH || pathname.startsWith(`${PASSWORD_PATH}/`)) {
    return null
  }
  return PASSWORD_PATH
}

/** Which field an error belongs under. */
export type PasswordField = "current" | "next" | "confirm"

export interface PasswordProblem {
  field: PasswordField
  message: string
}

/**
 * What the screen can tell on its own, before the server is asked: an empty
 * current password, a new one that is too short or unchanged, and two
 * entries that do not match. Anything else (a wrong current password, a
 * password the server refuses for its own reasons) comes back from the
 * server in its own words.
 */
export function checkNewPassword(input: {
  current: string
  next: string
  confirm: string
}): PasswordProblem | null {
  if (!input.current) {
    return { field: "current", message: "Enter your current password." }
  }
  if (input.next.length < MIN_PASSWORD_LENGTH || input.next === input.current) {
    return { field: "next", message: PASSWORD_REFUSAL }
  }
  if (input.confirm !== input.next) {
    return {
      field: "confirm",
      message: "The two new passwords are different. Type the same one twice.",
    }
  }
  return null
}
