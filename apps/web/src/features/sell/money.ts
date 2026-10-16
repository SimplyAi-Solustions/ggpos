import { formatGBP } from "@gg/shared"

/** "12.50" from 1250, for seeding a money field from a stored amount. */
export function penceToField(pence: number): string {
  return formatGBP(pence).replace("£", "").replace(/,/g, "")
}
