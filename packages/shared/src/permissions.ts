/**
 * Who may do what at the till (docs/EPOS-PLAN.md, "Staff, roles and PIN").
 *
 * Three roles, ranked: staff < manager < admin. Each capability names the
 * lowest role allowed to use it; an admin can change that table under
 * Settings, except for the two capabilities that manage the table itself and
 * the staff list, which stay admin-only whatever the table says. A staff
 * member without a capability can still do the thing at the till if a
 * manager (anyone whose role holds that capability) approves it with their
 * PIN on the spot; the server issues a single-use override for that one
 * action (pb_hooks/lib/permissions.js).
 *
 * Pure and shared: the counter uses it to decide whether to show a control
 * or ask for approval first, and the hooks use the generated copy in
 * pb/pb_hooks/lib/shared/permissions.js to enforce it. The server's answer is
 * the one that counts.
 */

export const ROLES = ["staff", "manager", "admin"] as const
export type Role = (typeof ROLES)[number]

const ROLE_RANK: Record<Role, number> = { staff: 1, manager: 2, admin: 3 }

export const CAPABILITIES = [
  "till_open",
  "x_report",
  "z_report",
  "no_sale",
  "paid_in_out",
  "refund",
  "discount_over_limit",
  "price_override",
  "void_line",
  "reprint",
  "stock_manage",
  "bookings_manage",
  "reports_view",
  "settings_manage",
  "staff_manage",
] as const
export type Capability = (typeof CAPABILITIES)[number]

export type PermissionTable = Record<Capability, Role>

/** Fixed at admin: an admin table that could hand these out could lock admins out of it. */
const ADMIN_ONLY: readonly Capability[] = ["settings_manage", "staff_manage"]

export const DEFAULT_PERMISSIONS: PermissionTable = {
  till_open: "staff",
  x_report: "staff",
  z_report: "manager",
  no_sale: "manager",
  paid_in_out: "manager",
  refund: "manager",
  discount_over_limit: "manager",
  price_override: "manager",
  void_line: "staff",
  reprint: "staff",
  stock_manage: "manager",
  bookings_manage: "staff",
  reports_view: "manager",
  settings_manage: "admin",
  staff_manage: "admin",
}

/** Short labels for the permissions table and for "A manager needs to approve this" prompts. */
export const CAPABILITY_LABELS: Record<Capability, string> = {
  till_open: "Open the till",
  x_report: "Run an X report",
  z_report: "Run the Z report and cash up",
  no_sale: "Open the drawer with no sale",
  paid_in_out: "Pay cash in or out",
  refund: "Give a refund",
  discount_over_limit: "Discount over the limit",
  price_override: "Change a price",
  void_line: "Remove a line from a ticket",
  reprint: "Reprint a receipt",
  stock_manage: "Manage stock",
  bookings_manage: "Manage bookings",
  reports_view: "See reports",
  settings_manage: "Change settings",
  staff_manage: "Manage staff",
}

export const ROLE_LABELS: Record<Role, string> = {
  staff: "Staff",
  manager: "Manager",
  admin: "Admin",
}

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value)
}

export function isCapability(value: unknown): value is Capability {
  return typeof value === "string" && (CAPABILITIES as readonly string[]).includes(value)
}

/**
 * The table in force: the defaults, overlaid with whatever valid entries the
 * stored settings carry (`settings.epos.permissions`). Unknown capabilities
 * and roles are ignored rather than trusted, and the admin-only pair always
 * stays at admin.
 */
export function resolvePermissions(stored: unknown): PermissionTable {
  const table: PermissionTable = { ...DEFAULT_PERMISSIONS }
  if (stored && typeof stored === "object" && !Array.isArray(stored)) {
    for (const [key, value] of Object.entries(stored as Record<string, unknown>)) {
      if (isCapability(key) && isRole(value)) table[key] = value
    }
  }
  for (const key of ADMIN_ONLY) table[key] = "admin"
  return table
}

/** Whether a role holds a capability under the given table. An unknown role holds nothing. */
export function can(role: unknown, capability: Capability, table: PermissionTable = DEFAULT_PERMISSIONS): boolean {
  if (!isRole(role)) return false
  const needed = table[capability] ?? "admin"
  return ROLE_RANK[role] >= ROLE_RANK[needed]
}

/** The lowest role that may approve a capability: the role named in the table. */
export function approverRole(capability: Capability, table: PermissionTable = DEFAULT_PERMISSIONS): Role {
  return table[capability] ?? "admin"
}

/**
 * PIN rules: exactly 4 or 6 digits, and not a run or a repeat that anybody
 * would try first. Returns the sentence to show, or null when the PIN is fine.
 */
export function pinProblem(pin: unknown): string | null {
  if (typeof pin !== "string" || !/^(\d{4}|\d{6})$/.test(pin)) {
    return "A PIN is 4 or 6 digits."
  }
  const digits = pin.split("").map(Number)
  const repeat = digits.every((d) => d === digits[0])
  let up = true
  let down = true
  digits.slice(1).forEach((d, i) => {
    const prev = digits[i] ?? 0
    if (d !== (prev + 1) % 10) up = false
    if (d !== (prev + 9) % 10) down = false
  })
  if (repeat || up || down) {
    return "Choose a PIN that is not a run or a repeat, such as 1234 or 0000."
  }
  return null
}
