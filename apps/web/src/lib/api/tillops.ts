/**
 * Cashing up, the drawer, registers and till devices
 * (docs/api-contract-epos.md, sections 1, 2 and 3).
 *
 * Every till route takes an optional `register`; this browser's
 * registration names one (`currentRegisterId()`), and without one the
 * server uses the default register, so a browser that is not a till still
 * cashes up the shop's one counter. The device header goes on every call:
 * the movement route reads it when it is there, and the device routes need
 * it.
 *
 * The routes that need a capability (`till_open`, `x_report`, `z_report`,
 * `paid_in_out`, `no_sale`) take the override headers the caller collects
 * through `withOverride` (`features/lock/override.ts`), so a member of
 * staff without the capability gets a manager's approval and the same call
 * goes again.
 */
import type {
  DenominationCounts,
  PrintJob,
  TillDevice,
  TillReport,
  TillReportSummary,
  TillSession,
} from "@gg/shared"

import { pb } from "@/lib/pb"
import { isDemo } from "@/lib/api/mode"
import { noteNetworkSuccess } from "@/lib/offline/net"
import { currentRegisterId } from "@/lib/api/till-session"
import { deviceHeaders } from "@/lib/till-device"
import * as demo from "@/lib/api/demo/till-session"

const STEP_UP_HEADER = "X-Step-Up"

type Headers = Record<string, string>

function withDevice(headers: Headers = {}): Headers {
  return { ...deviceHeaders(), ...headers }
}

function registerBody(): { register?: string } {
  const register = currentRegisterId()
  return register ? { register } : {}
}

/** The routes answer `print_job` as `{ id, status }` or null. */
export type QueuedJob = Pick<PrintJob, "id" | "status"> | null

export type MovementType = "paid_in" | "paid_out" | "bank_drop" | "adjustment"

export interface MovementInput {
  type: MovementType
  /** Pence above zero; an adjustment may be negative. */
  amount: number
  reason: string
}

export interface MovementResult {
  movement: { id: string; type: string; amount: number; reason?: string }
  print_job: QueuedJob
}

export interface NoSaleResult {
  event: { id: string; kind?: string }
  print_job: QueuedJob
}

export interface ZInput {
  counts: DenominationCounts
  /** The Tide total keyed from the Tide app, or null when there is none to key. */
  card_reported_total: number | null
  bank_drop?: number
  notes?: string
}

export interface ReportPage {
  items: TillReportSummary[]
  page: number
  per_page: number
  total: number
}

// ---------------------------------------------------------------------------
// The session
// ---------------------------------------------------------------------------

/** Open the till: `counts` makes the float their total; otherwise `float` stands. */
export async function openTill(
  input: { counts?: DenominationCounts; float?: number },
  headers: Headers = {}
): Promise<TillSession> {
  if (isDemo()) return demo.demoOpenTill(input, headers)
  const result = await pb.send<{ session: TillSession }>("/api/vault/till/open", {
    method: "POST",
    headers: withDevice(headers),
    body: { ...registerBody(), ...input },
  })
  return result.session
}

/** A saved, numbered X report. */
export async function runXReport(headers: Headers = {}): Promise<TillReport> {
  if (isDemo()) return demo.demoRunX(headers)
  const result = await pb.send<{ report: TillReport }>("/api/vault/till/x", {
    method: "POST",
    headers: withDevice(headers),
    body: registerBody(),
  })
  return result.report
}

/** The Z: counts the drawer, closes the session, and is never changed again. */
export async function runZReport(
  input: ZInput,
  headers: Headers = {}
): Promise<{ report: TillReport; session: TillSession }> {
  if (isDemo()) return demo.demoRunZ(input, headers)
  return pb.send<{ report: TillReport; session: TillSession }>("/api/vault/till/z", {
    method: "POST",
    headers: withDevice(headers),
    body: { ...registerBody(), ...input },
  })
}

/** Paid in, paid out, a bank drop or an adjustment. */
export async function recordMovement(
  input: MovementInput,
  headers: Headers = {}
): Promise<MovementResult> {
  if (isDemo()) return demo.demoMovement(input, headers)
  return pb.send<MovementResult>("/api/vault/till/movement", {
    method: "POST",
    headers: withDevice(headers),
    body: { ...registerBody(), ...input },
  })
}

/** Opens the drawer with nothing sold, and says why. */
export async function recordNoSale(reason: string, headers: Headers = {}): Promise<NoSaleResult> {
  if (isDemo()) return demo.demoNoSale(reason, headers)
  return pb.send<NoSaleResult>("/api/vault/till/no-sale", {
    method: "POST",
    headers: withDevice(headers),
    body: { ...registerBody(), reason },
  })
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

export async function listTillReports(
  options: { type?: "x" | "z"; page?: number; perPage?: number } = {},
  headers: Headers = {}
): Promise<ReportPage> {
  if (isDemo()) return demo.demoListReports(options)
  const query: Record<string, string | number> = {
    page: options.page ?? 1,
    per_page: options.perPage ?? 20,
  }
  const register = currentRegisterId()
  if (register) query.register = register
  if (options.type) query.type = options.type
  const result = await pb.send<ReportPage>("/api/vault/till/reports", {
    method: "GET",
    headers: withDevice(headers),
    query,
  })
  noteNetworkSuccess()
  return result
}

export async function getTillReport(id: string, headers: Headers = {}): Promise<TillReport> {
  if (isDemo()) return demo.demoGetReport(id)
  const result = await pb.send<{ report: TillReport }>(
    `/api/vault/till/reports/${encodeURIComponent(id)}`,
    { method: "GET", headers: withDevice(headers) }
  )
  return result.report
}

// ---------------------------------------------------------------------------
// Registers (the `registers` collection: staff read, admin write)
// ---------------------------------------------------------------------------

export interface RegisterRow {
  id: string
  name: string
  active: boolean
  sort: number
}

function toRegister(row: { id: string; name?: string; active?: boolean; sort?: number }): RegisterRow {
  return {
    id: row.id,
    name: row.name ?? "",
    active: row.active === true,
    sort: row.sort ?? 0,
  }
}

export async function listRegisters(): Promise<RegisterRow[]> {
  if (isDemo()) return demo.demoListRegisters()
  const rows = await pb
    .collection("registers")
    .getFullList<RegisterRow>({ sort: "sort,name" })
  noteNetworkSuccess()
  return rows.map(toRegister)
}

export async function createRegister(name: string, sort: number): Promise<RegisterRow> {
  if (isDemo()) return demo.demoCreateRegister(name)
  const row = await pb
    .collection("registers")
    .create<RegisterRow>({ name: name.trim(), active: true, sort })
  return toRegister(row)
}

export async function updateRegister(
  id: string,
  patch: { name?: string; active?: boolean }
): Promise<RegisterRow> {
  if (isDemo()) return demo.demoUpdateRegister(id, patch)
  const body = patch.name !== undefined ? { ...patch, name: patch.name.trim() } : patch
  const row = await pb.collection("registers").update<RegisterRow>(id, body)
  return toRegister(row)
}

// ---------------------------------------------------------------------------
// Till devices
// ---------------------------------------------------------------------------

/** One row of `GET /api/vault/till/devices`. */
export interface DeviceRow {
  id: string
  register: string
  register_name: string
  label: string
  created_by_name: string
  last_seen: string
  revoked_at: string
}

/** What registering hands back once: the device, and its secret. */
export interface RegisteredDevice {
  device: TillDevice & { created?: string }
  secret: string
}

/** Register this browser to a register. Manager or admin, with a step-up. */
export async function registerDevice(
  input: { register: string; label: string },
  stepUpToken: string
): Promise<RegisteredDevice> {
  if (isDemo()) return demo.demoRegisterDevice(input)
  return pb.send<RegisteredDevice>("/api/vault/till/devices", {
    method: "POST",
    headers: { [STEP_UP_HEADER]: stepUpToken },
    body: { register: input.register, label: input.label.trim() },
  })
}

export async function listDevices(): Promise<DeviceRow[]> {
  if (isDemo()) return demo.demoListDevices()
  const result = await pb.send<{ devices: DeviceRow[] }>("/api/vault/till/devices", {
    method: "GET",
  })
  noteNetworkSuccess()
  return result.devices ?? []
}

/** Revoke a device: its next request is refused. */
export async function revokeDevice(id: string): Promise<void> {
  if (isDemo()) return demo.demoRevokeDevice(id)
  await pb.send(`/api/vault/till/devices/${encodeURIComponent(id)}`, { method: "DELETE" })
}

/** This browser's registration as the server sees it; a 401 means it was revoked. */
export async function checkThisDevice(): Promise<{
  device: TillDevice
  register: { id: string; name: string; active: boolean }
}> {
  if (isDemo()) return demo.demoCheckDevice()
  return pb.send("/api/vault/till/device", { method: "GET", headers: deviceHeaders() })
}
