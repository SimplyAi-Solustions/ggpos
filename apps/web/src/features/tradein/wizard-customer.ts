import type { WizardCustomer } from "@/features/tradein/machine"
import type { CustomerProfile, IdStatus } from "@/lib/api"

/**
 * A customer profile in the shape the buy-in's cash gate reads: their ID
 * status and expiry, their flags, their date of birth and address. The
 * wizard's customer step and the till's part-exchange both read a seller
 * through this, so the same facts decide whether cash can be paid.
 */
export function toWizardCustomer(profile: CustomerProfile): WizardCustomer {
  return {
    id: profile.customer.id,
    name: profile.customer.name,
    code: profile.customer.code,
    email: profile.customer.email ?? "",
    phone: profile.customer.phone ?? "",
    creditBalance: profile.private?.credit_balance ?? 0,
    facts: {
      flags: profile.private?.flags ?? [],
      idStatus: (profile.private?.id_status ?? "none") as IdStatus,
      idType: profile.private?.id_type,
      idExpiry: profile.private?.id_expiry,
      dob: profile.private?.dob,
      address: profile.private?.address,
    },
  }
}
