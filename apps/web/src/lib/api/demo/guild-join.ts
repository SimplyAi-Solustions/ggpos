/**
 * Joining the GG Guild in the demo shop, with the route's refusals in the
 * route's sentences (docs/api-contract-launch.md, section 2;
 * pb/pb_hooks/guild.pb.js): a name and an email or a phone for somebody
 * new, a clash naming the customer who already holds that email or phone,
 * a member refused a second time, and the welcome bonus once.
 */
import { ClientResponseError } from "pocketbase"
import { isGuildMember } from "@gg/shared"

import {
  demoCreateCustomer,
  demoCustomers,
  findDemoCustomer,
  type DemoCustomer,
} from "@/lib/api/demo/customers"
import { demoWelcomeBonus } from "@/lib/api/demo/loyalty"
import { ensureDemoSaleCustomer } from "@/lib/api/demo/store"
import type { GuildJoinInput, GuildJoinResult } from "@/lib/api/guild-join"

function refusal(status: number, message: string, extra: Record<string, unknown> = {}): ClientResponseError {
  return new ClientResponseError({ status, response: { code: status, message, data: {}, ...extra } })
}

/** Digits only, a UK +44 number as its 0 form, as the server compares them. */
function phoneKey(value: string | undefined): string {
  let digits = (value ?? "").replace(/\D/g, "")
  if (digits.startsWith("44") && digits.length === 12) digits = `0${digits.slice(2)}`
  return digits
}

function clash(email: string, phone: string): { entry: DemoCustomer; field: "email" | "phone" } | null {
  if (email) {
    const byEmail = demoCustomers.find((entry) => (entry.customer.email ?? "").toLowerCase() === email)
    if (byEmail) return { entry: byEmail, field: "email" }
  }
  const key = phoneKey(phone)
  if (key.length >= 4) {
    const byPhone = demoCustomers.find((entry) => phoneKey(entry.customer.phone) === key)
    if (byPhone) return { entry: byPhone, field: "phone" }
  }
  return null
}

export function demoJoinGuild(input: GuildJoinInput): GuildJoinResult {
  let entry: DemoCustomer | null
  if (input.customer) {
    entry = findDemoCustomer(input.customer)
    if (!entry) throw refusal(404, "That customer no longer exists. Search again.")
    if (isGuildMember(entry.customer.guild_joined_at)) {
      throw refusal(409, `${entry.customer.name} is already in the Guild.`)
    }
  } else {
    const name = (input.name ?? "").trim()
    const email = (input.email ?? "").trim().toLowerCase()
    const phone = (input.phone ?? "").trim()
    if (!name || (!email && !phone)) {
      throw refusal(400, "Add a name and an email or a phone number.")
    }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw refusal(400, "That email address does not look right. Check it and try again.")
    }
    const held = clash(email, phone)
    if (held) {
      const what = held.field === "email" ? "that email" : "that phone number"
      throw refusal(409, `${held.entry.customer.name} already has ${what}. Open their record instead.`, {
        customer: { id: held.entry.customer.id, name: held.entry.customer.name, code: held.entry.customer.code },
      })
    }
    const record = demoCreateCustomer({
      name,
      email: email || undefined,
      phone: phone || undefined,
      marketingConsent: input.marketing_consent,
    })
    entry = findDemoCustomer(record.id)
    if (!entry) throw refusal(500, "The customer could not be made. Try again.")
  }
  if (input.birthday_month !== undefined && (input.birthday_month < 1 || input.birthday_month > 12)) {
    throw refusal(400, "A birthday month is a number from 1 to 12.")
  }

  entry.customer.guild_joined_at = new Date().toISOString()
  entry.customer.marketing_consent = input.marketing_consent
  if (input.birthday_month) entry.customer.birthday_month = input.birthday_month
  if (!entry.private.tier) entry.private.tier = "tier_member"

  // The till's own copy of the customer carries its balance as a plain
  // field, so the bonus goes on both, as a sale's points do.
  const tillCustomer = ensureDemoSaleCustomer(entry)
  const welcome = demoWelcomeBonus(entry.customer.id)
  tillCustomer.pointsBalance += welcome

  return {
    customer: { id: entry.customer.id, name: entry.customer.name, code: entry.customer.code },
    points_balance: entry.private.points_balance ?? 0,
    welcome_points: welcome,
  }
}
