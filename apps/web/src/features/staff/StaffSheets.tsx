/**
 * Adding somebody, and everything an admin changes on an existing account:
 * name, role, active, a temporary password, and their PIN
 * (docs/api-contract-epos.md, section 2, "Staff management").
 *
 * Sheets, because each is a secondary task on the staff list. Every write
 * carries a step-up (`stepUp()` asks for the admin's own password once in
 * ten minutes). One block per sheet; the rest are text actions, each with
 * its result or its refusal said under it, in the server's words.
 */
import * as React from "react"
import { ROLES, pinProblem, type Role } from "@gg/shared"

import { Button } from "@/components/ui/button"
import { Chip, ChipGroup } from "@/components/ui/chip"
import { Field, FieldRow } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { SectionHeading } from "@/components/ui/micro-label"
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Switch } from "@/components/ui/switch"
import { StepUpCancelled, stepUp } from "@/lib/auth-stepup"
import { refusalOrFallback } from "@/lib/api/refusal"
import {
  clearStaffPin,
  createStaff,
  setStaffPassword,
  setStaffPin,
  updateStaff,
  type StaffMember,
} from "@/lib/api/staff"
import {
  emailProblem,
  passwordProblem,
  roleWord,
} from "@/features/staff/staff-words"

function RoleChips({
  value,
  onChange,
  label,
}: {
  value: Role
  onChange: (role: Role) => void
  label: string
}) {
  return (
    <ChipGroup
      aria-label={label}
      value={[value]}
      onValueChange={(next: string[]) => {
        const chosen = ROLES.find((role) => role === next[0])
        if (chosen) onChange(chosen)
      }}
    >
      {ROLES.map((role) => (
        <Chip key={role} value={role}>
          {roleWord(role)}
        </Chip>
      ))}
    </ChipGroup>
  )
}

/** Digits only, at most six, as they are typed. */
function pinDigits(text: string): string {
  return text.replace(/\D/g, "").slice(0, 6)
}

/** Runs a write behind a step-up; a closed prompt is "nothing happened". */
async function guarded<T>(write: (token: string) => Promise<T>): Promise<T | null> {
  try {
    return await write(await stepUp())
  } catch (cause) {
    if (cause instanceof StepUpCancelled) return null
    throw cause
  }
}

// ---------------------------------------------------------------------------
// Add
// ---------------------------------------------------------------------------

function AddForm({ onAdded, onCancel }: { onAdded: (member: StaffMember) => void; onCancel: () => void }) {
  const [name, setName] = React.useState("")
  const [email, setEmail] = React.useState("")
  const [role, setRole] = React.useState<Role>("staff")
  const [password, setPassword] = React.useState("")
  const [problem, setProblem] = React.useState<{
    field: "name" | "email" | "password" | "form"
    message: string
  } | null>(null)
  const [busy, setBusy] = React.useState(false)

  const errorFor = (field: "name" | "email" | "password" | "form") =>
    problem?.field === field ? problem.message : null

  async function save(event: React.FormEvent) {
    event.preventDefault()
    if (!name.trim()) {
      setProblem({ field: "name", message: "Give them a name: it is what the lock screen shows." })
      return
    }
    const badEmail = emailProblem(email)
    if (badEmail) {
      setProblem({ field: "email", message: badEmail })
      return
    }
    const badPassword = passwordProblem(password)
    if (badPassword) {
      setProblem({ field: "password", message: badPassword })
      return
    }
    setProblem(null)
    setBusy(true)
    try {
      const member = await guarded((token) =>
        createStaff({ name: name.trim(), email: email.trim(), role, password }, token)
      )
      if (member) onAdded(member)
    } catch (cause) {
      const message = refusalOrFallback(cause, "That account was not added. Try again.")
      setProblem({ field: /email/i.test(message) ? "email" : "form", message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={save} className="flex min-h-0 flex-1 flex-col" aria-label="Add a member of staff">
      <SheetBody>
        <FieldRow>
          <Field layout="stacked" label="Name" htmlFor="staff-name" error={errorFor("name")}>
            <Input
              id="staff-name"
              autoFocus
              autoComplete="off"
              maxLength={100}
              value={name}
              aria-invalid={errorFor("name") ? true : undefined}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          <Field layout="stacked" label="Email" htmlFor="staff-email" error={errorFor("email")}>
            <Input
              id="staff-email"
              type="email"
              inputMode="email"
              autoComplete="off"
              value={email}
              aria-invalid={errorFor("email") ? true : undefined}
              onChange={(event) => setEmail(event.target.value)}
            />
          </Field>
          <Field layout="stacked" label="Role">
            <RoleChips value={role} onChange={setRole} label="Role" />
          </Field>
          <Field
            layout="stacked"
            label="Temporary password"
            hint="At least 12 characters"
            htmlFor="staff-password"
            error={errorFor("password")}
          >
            <Input
              id="staff-password"
              type="password"
              autoComplete="new-password"
              value={password}
              aria-invalid={errorFor("password") ? true : undefined}
              onChange={(event) => setPassword(event.target.value)}
            />
          </Field>
        </FieldRow>
        <p className="mt-6 max-w-[56ch] text-[13px] leading-[1.45] text-muted-foreground-2">
          Tell them the password in person. They choose their own at their
          first sign-in, then set a PIN from their account menu.
        </p>
        {errorFor("form") ? (
          <p role="alert" className="mt-6 text-[13px] leading-[1.45] text-destructive">
            {errorFor("form")}
          </p>
        ) : null}
      </SheetBody>
      <SheetFooter>
        <Button type="submit" trailingArrow loading={busy}>
          Add member of staff
        </Button>
        <Button type="button" variant="text" onClick={onCancel}>
          Cancel
        </Button>
      </SheetFooter>
    </form>
  )
}

export function AddStaffSheet({
  open,
  onOpenChange,
  onAdded,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onAdded: (member: StaffMember) => void
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="pb-[env(safe-area-inset-bottom)]">
        <SheetHeader>
          <SheetTitle>Add a member of staff</SheetTitle>
          <SheetDescription>
            A counter account with a temporary password and a role.
          </SheetDescription>
        </SheetHeader>
        {open ? <AddForm onAdded={onAdded} onCancel={() => onOpenChange(false)} /> : null}
      </SheetContent>
    </Sheet>
  )
}

// ---------------------------------------------------------------------------
// Edit
// ---------------------------------------------------------------------------

type Said = { tone: "done" | "refused"; message: string }

function SaidLine({ said, testId }: { said: Said | null; testId: string }) {
  if (!said) return null
  return (
    <p
      data-testid={testId}
      role={said.tone === "refused" ? "alert" : undefined}
      aria-live="polite"
      className={
        said.tone === "refused"
          ? "mt-3 text-[13px] leading-[1.45] text-destructive"
          : "mt-3 text-[13px] leading-[1.45] text-muted-foreground"
      }
    >
      {said.message}
    </p>
  )
}

function EditForm({
  member,
  onChanged,
}: {
  member: StaffMember
  onChanged: (member: Partial<StaffMember> & { id: string }) => void
}) {
  const [name, setName] = React.useState(member.name)
  const [role, setRole] = React.useState<Role>(member.role)
  const [active, setActive] = React.useState(member.active)
  const [details, setDetails] = React.useState<Said | null>(null)
  const [saving, setSaving] = React.useState(false)

  const [password, setPassword] = React.useState("")
  const [passwordSaid, setPasswordSaid] = React.useState<Said | null>(null)
  const [passwordBusy, setPasswordBusy] = React.useState(false)

  const [pin, setPin] = React.useState("")
  const [pinSaid, setPinSaid] = React.useState<Said | null>(null)
  const [pinBusy, setPinBusy] = React.useState<"set" | "clear" | null>(null)

  const first = member.name.trim().split(/\s+/)[0] ?? member.name
  const dirty = name.trim() !== member.name || role !== member.role || active !== member.active

  async function saveDetails(event: React.FormEvent) {
    event.preventDefault()
    if (!name.trim()) {
      setDetails({ tone: "refused", message: "Give them a name: it is what the lock screen shows." })
      return
    }
    const patch: { name?: string; role?: Role; active?: boolean } = {}
    if (name.trim() !== member.name) patch.name = name.trim()
    if (role !== member.role) patch.role = role
    if (active !== member.active) patch.active = active
    if (!Object.keys(patch).length) return
    setSaving(true)
    setDetails(null)
    try {
      const done = await guarded((token) => updateStaff(member.id, patch, token))
      if (done !== null) {
        onChanged({ id: member.id, ...patch })
        setDetails({
          tone: "done",
          message:
            patch.active === false
              ? `${first} is inactive and signed out everywhere.`
              : "Saved.",
        })
      }
    } catch (cause) {
      setDetails({ tone: "refused", message: refusalOrFallback(cause, "Those changes did not save. Try again.") })
    } finally {
      setSaving(false)
    }
  }

  async function savePassword() {
    const problem = passwordProblem(password)
    if (problem) {
      setPasswordSaid({ tone: "refused", message: problem })
      return
    }
    setPasswordBusy(true)
    setPasswordSaid(null)
    try {
      const done = await guarded((token) => setStaffPassword(member.id, password, token).then(() => true))
      if (done) {
        setPassword("")
        onChanged({ id: member.id, must_change_password: true })
        setPasswordSaid({
          tone: "done",
          message: `${first} signs in with that password once, then chooses their own.`,
        })
      }
    } catch (cause) {
      setPasswordSaid({ tone: "refused", message: refusalOrFallback(cause, "The password did not change. Try again.") })
    } finally {
      setPasswordBusy(false)
    }
  }

  async function savePin() {
    const problem = pinProblem(pin)
    if (problem) {
      setPinSaid({ tone: "refused", message: problem })
      return
    }
    setPinBusy("set")
    setPinSaid(null)
    try {
      const done = await guarded((token) => setStaffPin(member.id, pin, token).then(() => true))
      if (done) {
        setPin("")
        onChanged({ id: member.id, pin_set: true, pin_locked: false })
        setPinSaid({ tone: "done", message: `${first}'s PIN is set, and unlocked if it was locked.` })
      }
    } catch (cause) {
      setPinSaid({ tone: "refused", message: refusalOrFallback(cause, "The PIN did not save. Try again.") })
    } finally {
      setPinBusy(null)
    }
  }

  async function removePin() {
    setPinBusy("clear")
    setPinSaid(null)
    try {
      const done = await guarded((token) => clearStaffPin(member.id, token).then(() => true))
      if (done) {
        onChanged({ id: member.id, pin_set: false, pin_locked: false })
        setPinSaid({ tone: "done", message: `${first} has no PIN now and signs in with a password.` })
      }
    } catch (cause) {
      setPinSaid({ tone: "refused", message: refusalOrFallback(cause, "The PIN was not cleared. Try again.") })
    } finally {
      setPinBusy(null)
    }
  }

  return (
    <SheetBody>
      <form onSubmit={saveDetails} aria-label={`${member.name}'s account`}>
        <FieldRow>
          <Field layout="stacked" label="Name" htmlFor="edit-staff-name">
            <Input
              id="edit-staff-name"
              autoComplete="off"
              maxLength={100}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          <Field layout="stacked" label="Role">
            <RoleChips value={role} onChange={setRole} label={`Role for ${member.name}`} />
          </Field>
          <Field layout="stacked" label="Active">
            <div className="flex items-center gap-4">
              <Switch
                checked={active}
                onCheckedChange={(checked: boolean) => setActive(checked)}
                aria-label={`${member.name} can sign in`}
              />
              <span className="text-[15px] text-foreground">
                {active ? "Can sign in" : "Cannot sign in"}
              </span>
            </div>
          </Field>
        </FieldRow>
        <SaidLine said={details} testId="staff-details-said" />
        <div className="mt-8">
          <Button type="submit" trailingArrow loading={saving} disabled={!dirty || saving} className="disabled:bg-surface-3 disabled:text-muted-foreground disabled:opacity-100">
            Save changes
          </Button>
        </div>
      </form>

      <SectionHeading className="mt-14">Password</SectionHeading>
      <Field layout="stacked" label="Temporary password" hint="At least 12 characters" htmlFor="edit-staff-password">
        <Input
          id="edit-staff-password"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
      </Field>
      <div className="mt-4">
        <Button variant="text" loading={passwordBusy} onClick={() => void savePassword()}>
          Set temporary password
        </Button>
      </div>
      <SaidLine said={passwordSaid} testId="staff-password-said" />

      <SectionHeading className="mt-14">PIN</SectionHeading>
      <p className="mb-6 text-[15px] leading-[1.5] text-muted-foreground" data-testid="staff-pin-state">
        {member.pin_locked
          ? `${first}'s PIN is locked after five wrong tries. A new PIN unlocks it.`
          : member.pin_set
            ? `${first} has a PIN.`
            : `${first} has no PIN yet.`}
      </p>
      <Field layout="stacked" label="New PIN" hint="4 or 6 digits" htmlFor="edit-staff-pin">
        <Input
          id="edit-staff-pin"
          type="password"
          inputMode="numeric"
          autoComplete="new-password"
          className="tnum font-mono tracking-[0.3em]"
          value={pin}
          onChange={(event) => setPin(pinDigits(event.target.value))}
        />
      </Field>
      <div className="mt-4 flex flex-wrap items-center gap-8">
        <Button variant="text" loading={pinBusy === "set"} onClick={() => void savePin()}>
          Set PIN
        </Button>
        {member.pin_set || member.pin_locked ? (
          <Button
            variant="text-destructive"
            loading={pinBusy === "clear"}
            onClick={() => void removePin()}
          >
            Clear PIN
          </Button>
        ) : null}
      </div>
      <SaidLine said={pinSaid} testId="staff-pin-said" />
    </SheetBody>
  )
}

export function EditStaffSheet({
  member,
  onOpenChange,
  onChanged,
}: {
  member: StaffMember | null
  onOpenChange: (open: boolean) => void
  onChanged: (member: Partial<StaffMember> & { id: string }) => void
}) {
  return (
    <Sheet open={member !== null} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="pb-[env(safe-area-inset-bottom)]">
        {member ? (
          <>
            <SheetHeader>
              <SheetTitle>{member.name}</SheetTitle>
              <SheetDescription>{member.email}</SheetDescription>
            </SheetHeader>
            <EditForm key={member.id} member={member} onChanged={onChanged} />
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  )
}
