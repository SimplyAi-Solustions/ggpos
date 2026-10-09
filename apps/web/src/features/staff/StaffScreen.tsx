/**
 * Staff, for admins (docs/EPOS-PLAN.md, "Staff, roles and PIN";
 * docs/api-contract-epos.md, section 2, "Staff management").
 *
 * The list says, for each person, their role, whether they can sign in,
 * whether they have a PIN or it is locked, and whether they still have to
 * change a temporary password, all in words. "Add a member of staff" is
 * the one block; a row opens its own sheet for the rest.
 */
import * as React from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"

import { Button } from "@/components/ui/button"
import { Lede, PageTitle } from "@/components/ui/page-title"
import { SkeletonText } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { DockedPrimary } from "@/features/cash/primary"
import { useStaffRole } from "@/features/lock/role"
import { AddStaffSheet, EditStaffSheet } from "@/features/staff/StaffSheets"
import {
  passwordWord,
  pinWord,
  roleWord,
  statusWord,
  summaryLine,
} from "@/features/staff/staff-words"
import { refusalOrFallback } from "@/lib/api/refusal"
import { listStaff, type StaffMember } from "@/lib/api/staff"

const STAFF_KEY = ["staff-list"] as const

function AdminsOnly() {
  return (
    <section className="pt-16 sm:pt-24">
      <PageTitle>Staff</PageTitle>
      <Lede>Staff accounts are for admins. Ask Richard if somebody needs adding.</Lede>
    </section>
  )
}

export function StaffScreen() {
  const role = useStaffRole()
  const admin = role === "admin"
  const queryClient = useQueryClient()

  const staff = useQuery({
    queryKey: STAFF_KEY,
    queryFn: listStaff,
    enabled: admin,
    staleTime: 15_000,
  })

  const [adding, setAdding] = React.useState(false)
  const [editing, setEditing] = React.useState<string | null>(null)
  const [notice, setNotice] = React.useState<string | null>(null)

  if (!admin) return <AdminsOnly />

  const rows = staff.data ?? []
  const member = rows.find((row) => row.id === editing) ?? null

  /** Fold a change into the list at once, then read it back from the server. */
  function changed(patch: Partial<StaffMember> & { id: string }) {
    queryClient.setQueryData<StaffMember[]>(STAFF_KEY, (current) =>
      (current ?? []).map((row) => (row.id === patch.id ? { ...row, ...patch } : row))
    )
    void queryClient.invalidateQueries({ queryKey: STAFF_KEY })
    // The lock screen's roster names, roles and PINs move with the list.
    void queryClient.invalidateQueries({ queryKey: ["till-roster"] })
  }

  return (
    <section className="pt-16 sm:pt-24">
      <PageTitle>Staff</PageTitle>
      <Lede>Who signs in to the counter, what they may do, and their PIN.</Lede>

      {notice ? (
        <p data-testid="staff-notice" aria-live="polite" className="mt-10 max-w-[56ch] text-[15px] leading-[1.5] text-foreground">
          {notice}
        </p>
      ) : null}

      <div className="mt-14">
        {staff.isPending ? (
          <SkeletonText lines={4} />
        ) : staff.error ? (
          <p role="alert" className="text-[15px] leading-[1.5] text-destructive">
            {refusalOrFallback(staff.error, "The staff list would not load. Check the connection and try again.")}
          </p>
        ) : (
          <>
            <div className="hidden min-[900px]:block">
              <Table data-testid="staff-table">
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Role</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>PIN</TableHead>
                    <TableHead>Password</TableHead>
                    <TableHead>
                      <span className="sr-only">Edit</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row) => (
                    <TableRow key={row.id} data-testid="staff-row">
                      <TableCell>
                        <span className="block text-[15px] text-foreground">{row.name}</span>
                        <span className="block text-[13px] text-muted-foreground-2">{row.email}</span>
                      </TableCell>
                      <TableCell>{roleWord(row.role)}</TableCell>
                      <TableCell className={row.active ? "" : "text-muted-foreground-2"}>
                        {statusWord(row)}
                      </TableCell>
                      <TableCell>{pinWord(row)}</TableCell>
                      <TableCell className="text-muted-foreground">{passwordWord(row)}</TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="text"
                          aria-label={`Edit ${row.name}`}
                          onClick={() => setEditing(row.id)}
                        >
                          Edit
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <ul className="min-[900px]:hidden" data-testid="staff-list-small">
              {rows.map((row) => (
                <li key={row.id} className="border-b border-hairline-soft first:border-t">
                  <button
                    type="button"
                    aria-label={`Edit ${row.name}`}
                    onClick={() => setEditing(row.id)}
                    className="flex min-h-14 w-full flex-col justify-center gap-1 py-3 text-left"
                  >
                    <span className="text-[15px] text-foreground">{row.name}</span>
                    <span className="text-[13px] text-muted-foreground-2">{summaryLine(row)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      <DockedPrimary className="mt-12 hidden min-[900px]:block">
        <Button trailingArrow onClick={() => setAdding(true)}>
          Add member of staff
        </Button>
      </DockedPrimary>

      <AddStaffSheet
        open={adding}
        onOpenChange={setAdding}
        onAdded={(added) => {
          setAdding(false)
          queryClient.setQueryData<StaffMember[]>(STAFF_KEY, (current) => [...(current ?? []), added])
          void queryClient.invalidateQueries({ queryKey: STAFF_KEY })
          void queryClient.invalidateQueries({ queryKey: ["till-roster"] })
          setNotice(
            `${added.name} is added as ${roleWord(added.role).toLowerCase()}. They choose their own password at first sign-in.`
          )
        }}
      />
      <EditStaffSheet
        member={member}
        onOpenChange={(open) => {
          if (!open) setEditing(null)
        }}
        onChanged={changed}
      />
    </section>
  )
}
