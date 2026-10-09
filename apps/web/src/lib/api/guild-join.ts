/**
 * Joining the GG Guild at the counter (docs/api-contract-launch.md, section
 * 2): `POST /api/vault/guild/join`, for an existing customer or a new one
 * made in the same step.
 *
 * The one refusal with more than a sentence in it is the clash: an email or
 * a phone number already on another customer answers 409 with that customer,
 * so the counter can open their record (or attach them at the till) instead
 * of making a second card.
 *
 * Demo mode answers the same shapes and refuses in the same sentences.
 */
import { ClientResponseError } from "pocketbase"

import { pb } from "@/lib/pb"
import { isDemo } from "@/lib/api/mode"
import { demoJoinGuild } from "@/lib/api/demo/guild-join"

/** `{ customer }` to join somebody on file; a name and an email or phone to make and join a new one. */
export interface GuildJoinInput {
  customer?: string
  name?: string
  email?: string
  phone?: string
  marketing_consent: boolean
  birthday_month?: number
}

export interface GuildJoinCustomer {
  id: string
  name: string
  /** The `GGC…` code, stored form. */
  code: string
}

export interface GuildJoinResult {
  customer: GuildJoinCustomer
  points_balance: number
  welcome_points: number
}

export async function joinGuild(input: GuildJoinInput): Promise<GuildJoinResult> {
  if (isDemo()) return demoJoinGuild(input)
  return pb.send<GuildJoinResult>("/api/vault/guild/join", { method: "POST", body: input })
}

/** The customer who already holds that email or phone, from a 409, or null. */
export function clashCustomer(error: unknown): GuildJoinCustomer | null {
  if (!(error instanceof ClientResponseError) || error.status !== 409) return null
  const customer = (error.response as { customer?: Partial<GuildJoinCustomer> } | undefined)?.customer
  if (!customer?.id) return null
  return { id: customer.id, name: customer.name ?? "", code: customer.code ?? "" }
}
