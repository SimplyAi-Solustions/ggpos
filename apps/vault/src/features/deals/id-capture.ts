import type { IdCheckPayload, SellerFacts } from "./api"
import { photoFileName } from "./id-photo"

export type IdType = "passport" | "driving_licence" | "other"

export const ID_TYPES: ReadonlyArray<{ value: IdType; label: string }> = [
  { value: "passport", label: "Passport" },
  { value: "driving_licence", label: "Driving licence" },
  { value: "other", label: "Other photo ID" },
]

/** Whole years between a date of birth and `now`, or null when unknown. */
export function ageAt(dob: string | undefined, now: Date): number | null {
  if (!dob) return null
  const born = new Date(dob)
  if (Number.isNaN(born.getTime())) return null
  let age = now.getFullYear() - born.getFullYear()
  const months = now.getMonth() - born.getMonth()
  if (months < 0 || (months === 0 && now.getDate() < born.getDate())) age -= 1
  return age
}

/** What a cash payout still needs from the ID step. */
export type IdGate =
  /** Nothing: verified fields in date, a photo still on file, and an address. */
  | { needed: false }
  /** The lot: photo, type, expiry, last four, date of birth and address. */
  | { needed: true; reason: "full" }
  /** The fields are good and the photo is there; only the address is not. */
  | { needed: true; reason: "address" }

/**
 * The server's cash gate (prepare() in lib/tradeincomplete.js) read off the
 * seller's facts: verified ID fields in date, a photo the retention cron has
 * not purged, and an address. Ported from apps/web's machine.ts idGate.
 */
export function idGate(facts: SellerFacts, now: Date = new Date()): IdGate {
  const expiry = facts.idExpiry ? new Date(facts.idExpiry) : null
  const fieldsGood =
    facts.idStatus === "verified" && expiry !== null && !Number.isNaN(expiry.getTime()) && expiry > now
  if (!fieldsGood || !facts.hasPhoto) return { needed: true, reason: "full" }
  if (!facts.address || facts.address.trim().length < 6) return { needed: true, reason: "address" }
  return { needed: false }
}

/** A standing refusal on the seller, in the server's words. Null when cash is allowed. */
export function cashRefusal(facts: SellerFacts, now: Date = new Date()): string | null {
  if (facts.flags.includes("no_cash")) return "This customer is marked no cash. Pay as store credit."
  const age = ageAt(facts.dob, now)
  if (facts.flags.includes("under_18") || (age !== null && age < 18)) {
    return "This customer is under 18, so cash is not an option. Offer store credit."
  }
  return null
}

/**
 * What the ID step collects, what is still missing from it, and the
 * multipart form the ID check route takes.
 *
 * Apart from the screen so the refusals can be unit tested: every one of
 * them is a rule `docs/PLAN.md` puts on a cash buy-in, not a validation
 * nicety.
 */

export interface IdCaptureValues {
  idType: IdType
  idExpiry: string
  idRefLast4: string
  dob: string
  address: string
  attested: boolean
  photo: Blob | null
}

export const EMPTY_CAPTURE: IdCaptureValues = {
  idType: "passport",
  idExpiry: "",
  idRefLast4: "",
  dob: "",
  address: "",
  attested: false,
  photo: null,
}

/**
 * What is still missing before the ID check can be sent.
 *
 * `gate` says which half of the check this is: a customer whose ID fields
 * and photo are already good but who has never given an address is asked
 * for the address and nothing else, because asking for a passport again
 * over a missing postcode wastes everybody's time.
 */
export function idCaptureProblem(
  values: IdCaptureValues,
  gate: IdGate = { needed: true, reason: "full" }
): string | null {
  if (!gate.needed) return null

  if (gate.reason === "address") {
    return values.address.trim().length < 6
      ? "Enter the customer's address. A cash buy-in needs it on the record."
      : null
  }

  if (!values.photo) return "Photograph the ID before you continue."
  if (!values.idExpiry) return "Enter the date the ID expires."
  if (new Date(values.idExpiry).getTime() <= Date.now()) {
    return "That ID has expired. Ask for one that is in date."
  }
  // The route takes 1 to 4 characters: some documents show fewer.
  if (values.idRefLast4.length < 1 || values.idRefLast4.length > 4) {
    return "Enter the last digits of the ID number, up to four."
  }
  if (!values.dob) return "Enter the customer's date of birth."
  const age = ageAt(values.dob, new Date())
  if (age !== null && age < 18) {
    return "This customer is under 18, so cash is not an option. Go back and offer store credit."
  }
  if (values.address.trim().length < 6) {
    return "Enter the customer's address. A cash buy-in needs it on the record."
  }
  if (!values.attested) return "Tick the attestation to say you saw the document."
  return null
}

/** The multipart form the ID check route takes. */
export function idCheckForm(values: IdCaptureValues): FormData {
  const form = new FormData()
  if (values.photo) form.append("photo", values.photo, photoFileName())
  form.append("id_type", values.idType)
  form.append("id_expiry", values.idExpiry)
  form.append("id_ref_last4", values.idRefLast4)
  form.append("dob", values.dob)
  form.append("address", values.address.trim())
  return form
}

/**
 * The `id_check` a cash payout carries, once the photo has been stored by
 * the ID check route and `documentId` names it. The buy-in's completion and
 * the till's part-exchange send exactly this (docs/api-contract-epos.md,
 * section 7: "exactly the buy-in's id_check").
 */
export function idCheckFrom(values: IdCaptureValues, documentId: string | null): IdCheckPayload {
  return {
    id_type: values.idType,
    id_expiry: values.idExpiry,
    id_ref_last4: values.idRefLast4,
    dob: values.dob,
    address: values.address.trim(),
    id_document: documentId,
  }
}
