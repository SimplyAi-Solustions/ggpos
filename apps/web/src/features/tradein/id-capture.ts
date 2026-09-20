import { ageAt } from "@/features/tradein/machine"
import { photoFileName } from "@/features/tradein/id-photo"
import type { IdType } from "@/lib/api"

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

/** What is still missing before the ID check can be sent. */
export function idCaptureProblem(values: IdCaptureValues): string | null {
  if (!values.photo) return "Photograph the ID before you continue."
  if (!values.idExpiry) return "Enter the date the ID expires."
  if (new Date(values.idExpiry).getTime() <= Date.now()) {
    return "That ID has expired. Ask for one that is in date."
  }
  if (values.idRefLast4.length !== 4) {
    return "Enter the last four digits of the ID number."
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
