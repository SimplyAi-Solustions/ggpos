/**
 * Who may do what at the till: each capability's lowest role
 * (docs/EPOS-PLAN.md, "Staff, roles and PIN"; packages/shared/src/permissions.ts).
 *
 * A hairline table, one row per capability, with the role chosen from a
 * select. Changing settings and managing staff stay with an admin whatever
 * the table says, because a table that could hand them out could lock the
 * admins out of it, so those two rows say "Admin" and are not choices.
 * Somebody below the role can still do the thing at the till when a
 * manager approves it with their PIN; the note says so.
 */
import {
  CAPABILITY_LABELS,
  ROLES,
  ROLE_LABELS,
  isRole,
  type PermissionTable,
  type Role,
} from "@gg/shared"

import { Hint } from "@/components/ui/micro-label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { FIXED_CAPABILITIES, PERMISSION_ORDER } from "@/features/settings/mapping"

export function PermissionsTable({
  value,
  onChange,
}: {
  value: PermissionTable
  onChange: (capability: keyof PermissionTable, role: Role) => void
}) {
  return (
    <>
      <p className="mb-8 max-w-[56ch] text-[13px] leading-[1.45] text-muted-foreground-2">
        The lowest role that may do each of these. Below it, the till asks a
        manager to approve with their PIN, and both names are kept.
      </p>
      <Table data-testid="permissions-table" aria-label="Permissions">
        <TableHeader>
          <TableRow>
            <TableHead>What</TableHead>
            <TableHead className="w-44">Lowest role</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {PERMISSION_ORDER.map((capability) => {
            const fixed = FIXED_CAPABILITIES.includes(capability)
            const label = CAPABILITY_LABELS[capability]
            return (
              <TableRow key={capability} data-testid={`permission-${capability}`}>
                <TableCell className="text-[15px]">{label}</TableCell>
                <TableCell className="w-44 py-1">
                  {fixed ? (
                    <span className="flex items-baseline gap-3 py-2">
                      <span className="text-[15px] text-foreground">{ROLE_LABELS.admin}</span>
                      <Hint>Fixed</Hint>
                    </span>
                  ) : (
                    <Select
                      value={value[capability]}
                      onValueChange={(next: string | null) => {
                        if (isRole(next)) onChange(capability, next)
                      }}
                    >
                      <SelectTrigger aria-label={`Lowest role for ${label.toLowerCase()}`}>
                        <SelectValue>
                          {(role: string) => (isRole(role) ? ROLE_LABELS[role] : role)}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {ROLES.map((role) => (
                          <SelectItem key={role} value={role}>
                            {ROLE_LABELS[role]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </>
  )
}
