/**
 * Settings, Guild (docs/api-contract-launch.md, section 2): the paid
 * upgrade's price, which is the Guild Membership till product's own price,
 * and the Guild's terms and welcome bonus, which are the loyalty
 * programme's. Admin only, like the rest of Settings: `loyalty_programme`
 * is admin-only and `till_products` takes a manager or an admin.
 *
 * Demo mode reads and writes the demo programme and the demo till.
 */
import { pb } from "@/lib/pb"
import { isDemo } from "@/lib/api/mode"
import { programme as demoProgramme, tiers as demoTiers } from "@/lib/api/demo/loyalty"
import { DEMO_TILL_PRODUCTS } from "@/lib/api/demo/till"

export interface GuildSettings {
  programmeId: string
  terms: string
  welcomeBonus: number
  /** The Guild Membership till product, or null when the shop has none. */
  product: {
    id: string
    name: string
    /** Pence. */
    price: number
    active: boolean
    months: number
    /** The paid-plan tier it grants, by name. */
    tierName: string
  } | null
}

export interface GuildSettingsWrite {
  programmeId: string
  terms: string
  welcomeBonus: number
  productId: string | null
  /** Pence. */
  price: number | null
}

interface ProductRow {
  id: string
  name?: string
  price?: number
  active?: boolean
  membership_months?: number
  expand?: { membership_tier?: { name?: string } }
}

export async function getGuildSettings(): Promise<GuildSettings> {
  if (isDemo()) {
    const product = DEMO_TILL_PRODUCTS.find((row) => row.kind === "membership") ?? null
    return {
      programmeId: demoProgramme.id,
      terms: demoProgramme.terms ?? "",
      welcomeBonus: demoProgramme.welcome_bonus ?? 0,
      product: product
        ? {
            id: product.id,
            name: product.name,
            price: product.price,
            active: product.active,
            months: product.membership_months,
            tierName: demoTiers.find((tier) => tier.id === product.membership_tier)?.name ?? "",
          }
        : null,
    }
  }
  const [programmePage, products] = await Promise.all([
    pb.collection("loyalty_programme").getList<{ id: string; terms?: string; welcome_bonus?: number }>(1, 1),
    pb.collection("till_products").getFullList<ProductRow>({
      filter: 'kind = "membership"',
      sort: "-active,sort",
      expand: "membership_tier",
    }),
  ])
  const programme = programmePage.items[0]
  if (!programme) throw new Error("This shop has no loyalty programme record yet. Run the migrations first.")
  const product = products[0] ?? null
  return {
    programmeId: programme.id,
    terms: programme.terms ?? "",
    welcomeBonus: programme.welcome_bonus ?? 0,
    product: product
      ? {
          id: product.id,
          name: product.name ?? "Guild Membership",
          price: product.price ?? 0,
          active: product.active !== false,
          months: product.membership_months ?? 0,
          tierName: product.expand?.membership_tier?.name ?? "",
        }
      : null,
  }
}

export async function saveGuildSettings(write: GuildSettingsWrite): Promise<GuildSettings> {
  if (isDemo()) {
    demoProgramme.terms = write.terms
    demoProgramme.welcome_bonus = write.welcomeBonus
    const product = DEMO_TILL_PRODUCTS.find((row) => row.id === write.productId)
    if (product && write.price !== null) product.price = write.price
    return getGuildSettings()
  }
  await pb.collection("loyalty_programme").update(write.programmeId, {
    terms: write.terms,
    welcome_bonus: write.welcomeBonus,
  })
  if (write.productId && write.price !== null) {
    await pb.collection("till_products").update(write.productId, { price: write.price })
  }
  return getGuildSettings()
}
