/**
 * Settings, Tills (docs/api-contract-epos.md, sections 1 and 2; DESIGN.md
 * section 10, "Lock screen and approval").
 *
 * Three things, each taking effect the moment it is done rather than on
 * the page's Save:
 * - **This browser**: whether it is a till, on which register and under
 *   what name; "Register this device" (a manager or an admin, with their
 *   password) and "Forget this device" for the local copy.
 * - **Registers**: the tills and their drawers. An admin adds, renames and
 *   switches them off; nobody deletes one, because sales and Z reports
 *   point at it.
 * - **Devices**: every browser registered as a till, newest first, with
 *   Revoke. A revoked device's next request is refused, and its lock falls
 *   back to the password.
 */
import * as React from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"

import { Button } from "@/components/ui/button"
import { Field, FieldRow } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Hint, MicroLabel, SectionHeading } from "@/components/ui/micro-label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { forgetDevice, rememberDevice, useLockDevice } from "@/features/lock/device"
import { readRefusal } from "@/features/lock/pin"
import { StepUpCancelled, stepUp } from "@/lib/auth-stepup"
import { refusalOrFallback } from "@/lib/api/refusal"
import {
  checkThisDevice,
  createRegister,
  listDevices,
  listRegisters,
  registerDevice,
  revokeDevice,
  updateRegister,
  type DeviceRow,
  type RegisterRow,
} from "@/lib/api/tillops"
import { formatDateTime } from "@/lib/dates"

const REGISTERS_KEY = ["registers"] as const
const DEVICES_KEY = ["till-devices"] as const

function Note({ children }: { children: React.ReactNode }) {
  return (
    <p className="max-w-[56ch] text-[13px] leading-[1.45] text-muted-foreground-2">{children}</p>
  )
}

// ---------------------------------------------------------------------------
// This browser
// ---------------------------------------------------------------------------

function ThisBrowser({
  registers,
  onRegister,
}: {
  registers: RegisterRow[]
  onRegister: () => void
}) {
  const device = useLockDevice()
  const check = useQuery({
    queryKey: ["this-device", device?.id ?? "none"],
    queryFn: checkThisDevice,
    enabled: device !== null,
    retry: false,
    staleTime: 30_000,
  })
  const refusal = check.error ? readRefusal(check.error) : null
  const registerName =
    registers.find((row) => row.id === device?.register)?.name || device?.register_name || "a register"

  return (
    <div data-testid="this-browser">
      <MicroLabel tone="ink" className="mb-4">
        This browser
      </MicroLabel>
      {device ? (
        <>
          <p className="max-w-[56ch] text-[15px] leading-[1.5] text-foreground">
            This browser is a till on {registerName}, as {device.label || "an unnamed device"}.
            Staff unlock it with their PIN.
          </p>
          <p
            data-testid="this-browser-check"
            className={
              refusal?.kind === "device"
                ? "mt-2 max-w-[56ch] text-[13px] leading-[1.45] text-destructive"
                : "mt-2 max-w-[56ch] text-[13px] leading-[1.45] text-muted-foreground-2"
            }
          >
            {check.isPending
              ? "Checking with the server."
              : refusal?.kind === "device"
                ? "The server no longer knows this device: it was revoked. Forget it here, then register it again."
                : refusal
                  ? refusal.message
                  : "The server knows this device."}
          </p>
          <div className="mt-4 flex flex-wrap gap-8">
            <Button variant="text-destructive" onClick={() => forgetDevice()}>
              Forget this device
            </Button>
          </div>
        </>
      ) : (
        <>
          <p className="max-w-[56ch] text-[15px] leading-[1.5] text-foreground">
            This browser is not a till. Register it so staff can unlock it and
            switch user with their PIN, and approve with a manager's PIN.
          </p>
          <div className="mt-4">
            <Button variant="text" onClick={onRegister}>
              Register this device
            </Button>
          </div>
        </>
      )}
    </div>
  )
}

function RegisterDeviceForm({
  registers,
  onDone,
  onCancel,
}: {
  registers: RegisterRow[]
  onDone: () => void
  onCancel: () => void
}) {
  const usable = registers.filter((row) => row.active)
  const [label, setLabel] = React.useState("")
  const [register, setRegister] = React.useState(usable[0]?.id ?? "")
  const [problem, setProblem] = React.useState<{ field: "label" | "form"; message: string } | null>(
    null
  )
  const [busy, setBusy] = React.useState(false)

  async function save(event: React.FormEvent) {
    event.preventDefault()
    if (!label.trim()) {
      setProblem({ field: "label", message: "Give this device a name, for example Counter Mac." })
      return
    }
    if (!register) {
      setProblem({ field: "form", message: "Switch a register on first, then register this device to it." })
      return
    }
    setProblem(null)
    setBusy(true)
    try {
      const result = await registerDevice({ register, label: label.trim() }, await stepUp())
      // The secret is handed over once and kept only in this browser.
      rememberDevice({
        id: result.device.id,
        secret: result.secret,
        register: result.device.register,
        register_name: result.device.register_name,
        label: result.device.label,
      })
      onDone()
    } catch (cause) {
      if (cause instanceof StepUpCancelled) return
      setProblem({
        field: "form",
        message: refusalOrFallback(cause, "This device was not registered. Try again."),
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={save} className="flex min-h-0 flex-1 flex-col" aria-label="Register this device">
      <SheetBody>
        <FieldRow>
          <Field
            layout="stacked"
            label="Name"
            htmlFor="device-label"
            error={problem?.field === "label" ? problem.message : null}
          >
            <Input
              id="device-label"
              autoFocus
              autoComplete="off"
              maxLength={60}
              placeholder="Counter Mac"
              value={label}
              aria-invalid={problem?.field === "label" ? true : undefined}
              onChange={(event) => setLabel(event.target.value)}
            />
          </Field>
          <Field layout="stacked" label="Register">
            <Select value={register || null} onValueChange={(next: string | null) => setRegister(next ?? "")}>
              <SelectTrigger aria-label="Register">
                <SelectValue placeholder="Choose a register">
                  {(value: string) => usable.find((row) => row.id === value)?.name ?? "Choose a register"}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {usable.map((row) => (
                  <SelectItem key={row.id} value={row.id}>
                    {row.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </FieldRow>
        <p className="mt-6 max-w-[56ch] text-[13px] leading-[1.45] text-muted-foreground-2">
          Your password confirms it. The device keeps a secret only this
          browser knows; clearing the browser's site data forgets it.
        </p>
        {problem?.field === "form" ? (
          <p role="alert" className="mt-6 text-[13px] leading-[1.45] text-destructive">
            {problem.message}
          </p>
        ) : null}
      </SheetBody>
      <SheetFooter>
        <Button type="submit" trailingArrow loading={busy}>
          Register this device
        </Button>
        <Button type="button" variant="text" onClick={onCancel}>
          Cancel
        </Button>
      </SheetFooter>
    </form>
  )
}

// ---------------------------------------------------------------------------
// Registers
// ---------------------------------------------------------------------------

function RegisterNameForm({
  register,
  registers,
  onDone,
  onCancel,
}: {
  register: RegisterRow | null
  registers: RegisterRow[]
  onDone: () => void
  onCancel: () => void
}) {
  const [name, setName] = React.useState(register?.name ?? "")
  const [problem, setProblem] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)

  async function save(event: React.FormEvent) {
    event.preventDefault()
    const clean = name.trim()
    if (!clean) {
      setProblem("Give the register a name, for example Back counter.")
      return
    }
    if (
      registers.some(
        (row) => row.id !== register?.id && row.name.trim().toLowerCase() === clean.toLowerCase()
      )
    ) {
      setProblem(`There is already a register called ${clean}. Choose another name.`)
      return
    }
    setProblem(null)
    setBusy(true)
    try {
      if (register) await updateRegister(register.id, { name: clean })
      else await createRegister(clean, Math.max(0, ...registers.map((row) => row.sort)) + 1)
      onDone()
    } catch (cause) {
      setProblem(refusalOrFallback(cause, "The register did not save. Try again."))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={save} className="flex min-h-0 flex-1 flex-col" aria-label={register ? "Rename register" : "Add a register"}>
      <SheetBody>
        <Field layout="stacked" label="Name" htmlFor="register-name" error={problem}>
          <Input
            id="register-name"
            autoFocus
            autoComplete="off"
            maxLength={60}
            value={name}
            aria-invalid={problem ? true : undefined}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
      </SheetBody>
      <SheetFooter>
        <Button type="submit" trailingArrow loading={busy}>
          {register ? "Save name" : "Add register"}
        </Button>
        <Button type="button" variant="text" onClick={onCancel}>
          Cancel
        </Button>
      </SheetFooter>
    </form>
  )
}

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------

function DeviceLine({
  row,
  thisId,
  onRevoked,
}: {
  row: DeviceRow
  thisId: string | null
  onRevoked: () => void
}) {
  const [confirming, setConfirming] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const revoked = Boolean(row.revoked_at)

  async function revoke() {
    setBusy(true)
    setError(null)
    try {
      await revokeDevice(row.id)
      setConfirming(false)
      onRevoked()
    } catch (cause) {
      setError(refusalOrFallback(cause, "The device was not revoked. Try again."))
    } finally {
      setBusy(false)
    }
  }

  return (
    <li data-testid="device-row" className="border-b border-hairline-soft py-4 first:border-t">
      <div className="flex flex-wrap items-baseline justify-between gap-x-8 gap-y-2">
        <span className="flex min-w-0 flex-col gap-1">
          <span className="text-[15px] text-foreground">
            {row.label}
            {row.id === thisId ? (
              <Hint className="ml-3 inline">This browser</Hint>
            ) : null}
          </span>
          <span className="text-[13px] leading-[1.45] text-muted-foreground-2">
            {row.register_name}
            {row.created_by_name ? `, added by ${row.created_by_name}` : ""}
            {revoked
              ? `. Revoked ${formatDateTime(row.revoked_at)}.`
              : row.last_seen
                ? `. Last seen ${formatDateTime(row.last_seen)}.`
                : ". Not seen yet."}
          </span>
        </span>
        {revoked ? (
          <Hint>Revoked</Hint>
        ) : confirming ? (
          <span className="flex flex-wrap items-center gap-6">
            <Button variant="text-destructive" loading={busy} onClick={() => void revoke()}>
              Revoke {row.label}
            </Button>
            <Button variant="text" onClick={() => setConfirming(false)}>
              Keep
            </Button>
          </span>
        ) : (
          <Button variant="text-destructive" aria-label={`Revoke ${row.label}`} onClick={() => setConfirming(true)}>
            Revoke
          </Button>
        )}
      </div>
      {confirming ? (
        <p className="mt-2 text-[13px] leading-[1.45] text-muted-foreground">
          It stops unlocking with a PIN at once, and needs registering again.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="mt-2 text-[13px] text-destructive">
          {error}
        </p>
      ) : null}
    </li>
  )
}

// ---------------------------------------------------------------------------
// The section
// ---------------------------------------------------------------------------

type SheetState =
  | { kind: "device" }
  | { kind: "register"; register: RegisterRow | null }
  | null

export function TillsSection({ admin }: { admin: boolean }) {
  const queryClient = useQueryClient()
  const device = useLockDevice()
  const [sheet, setSheet] = React.useState<SheetState>(null)
  const [registerError, setRegisterError] = React.useState<string | null>(null)

  const registers = useQuery({ queryKey: REGISTERS_KEY, queryFn: listRegisters, staleTime: 30_000 })
  const devices = useQuery({ queryKey: DEVICES_KEY, queryFn: listDevices, staleTime: 15_000 })
  const rows = registers.data ?? []

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: REGISTERS_KEY })
    void queryClient.invalidateQueries({ queryKey: DEVICES_KEY })
    void queryClient.invalidateQueries({ queryKey: ["this-device"] })
    void queryClient.invalidateQueries({ queryKey: ["till-roster"] })
    void queryClient.invalidateQueries({ queryKey: ["till-current"] })
  }

  async function toggle(row: RegisterRow) {
    setRegisterError(null)
    try {
      await updateRegister(row.id, { active: !row.active })
      refresh()
    } catch (cause) {
      setRegisterError(refusalOrFallback(cause, "The register did not change. Try again."))
    }
  }

  return (
    <section className="mt-24" aria-labelledby="tills-heading" data-testid="tills-section">
      <SectionHeading id="tills-heading">Tills</SectionHeading>
      <Note>
        Registers are the tills and their drawers. A browser registered to one
        locks to the PIN screen. Everything here takes effect straight away,
        not on Save.
      </Note>

      <div className="mt-10 flex flex-col gap-14">
        <ThisBrowser registers={rows} onRegister={() => setSheet({ kind: "device" })} />

        <div>
          <MicroLabel tone="ink" className="mb-4">
            Registers
          </MicroLabel>
          {registers.error ? (
            <p role="alert" className="text-[15px] text-destructive">
              {refusalOrFallback(registers.error, "The registers would not load. Try again.")}
            </p>
          ) : (
            <ul data-testid="register-list">
              {rows.map((row) => (
                <li
                  key={row.id}
                  data-testid="register-row"
                  className="flex min-h-14 flex-wrap items-center justify-between gap-x-8 gap-y-2 border-b border-hairline-soft py-3 first:border-t"
                >
                  <span className="flex items-baseline gap-3">
                    <span className="text-[15px] text-foreground">{row.name}</span>
                    {row.active ? null : <Hint>Switched off</Hint>}
                  </span>
                  {admin ? (
                    <span className="flex flex-wrap items-center gap-6">
                      <Button
                        variant="text"
                        aria-label={`Rename ${row.name}`}
                        onClick={() => setSheet({ kind: "register", register: row })}
                      >
                        Rename
                      </Button>
                      <Button
                        variant="text"
                        aria-label={`${row.active ? "Switch off" : "Switch on"} ${row.name}`}
                        onClick={() => void toggle(row)}
                      >
                        {row.active ? "Switch off" : "Switch on"}
                      </Button>
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          {registerError ? (
            <p role="alert" className="mt-3 text-[13px] text-destructive">
              {registerError}
            </p>
          ) : null}
          {admin ? (
            <div className="mt-4">
              <Button variant="text" onClick={() => setSheet({ kind: "register", register: null })}>
                Add a register
              </Button>
            </div>
          ) : (
            <div className="mt-3">
              <Note>An admin adds, renames and switches registers off.</Note>
            </div>
          )}
        </div>

        <div>
          <MicroLabel tone="ink" className="mb-4">
            Devices
          </MicroLabel>
          {devices.error ? (
            <p role="alert" className="text-[15px] text-destructive">
              {refusalOrFallback(devices.error, "The devices would not load. Try again.")}
            </p>
          ) : (devices.data ?? []).length === 0 ? (
            <p className="text-[15px] text-muted-foreground-2">No browser is registered as a till yet.</p>
          ) : (
            <ul data-testid="device-list">
              {(devices.data ?? []).map((row) => (
                <DeviceLine key={row.id} row={row} thisId={device?.id ?? null} onRevoked={refresh} />
              ))}
            </ul>
          )}
        </div>
      </div>

      <Sheet
        open={sheet !== null}
        onOpenChange={(open) => {
          if (!open) setSheet(null)
        }}
      >
        <SheetContent side="right" className="pb-[env(safe-area-inset-bottom)]">
          {sheet?.kind === "device" ? (
            <>
              <SheetHeader>
                <SheetTitle>Register this device</SheetTitle>
                <SheetDescription>
                  Makes this browser a till: the PIN lock, user switching and
                  manager approval work here.
                </SheetDescription>
              </SheetHeader>
              <RegisterDeviceForm
                registers={rows}
                onDone={() => {
                  setSheet(null)
                  refresh()
                }}
                onCancel={() => setSheet(null)}
              />
            </>
          ) : sheet?.kind === "register" ? (
            <>
              <SheetHeader>
                <SheetTitle>{sheet.register ? `Rename ${sheet.register.name}` : "Add a register"}</SheetTitle>
                <SheetDescription>
                  A register is a till and its drawer, with its own cash session and Z report.
                </SheetDescription>
              </SheetHeader>
              <RegisterNameForm
                key={sheet.register?.id ?? "new"}
                register={sheet.register}
                registers={rows}
                onDone={() => {
                  setSheet(null)
                  refresh()
                }}
                onCancel={() => setSheet(null)}
              />
            </>
          ) : null}
        </SheetContent>
      </Sheet>
    </section>
  )
}
