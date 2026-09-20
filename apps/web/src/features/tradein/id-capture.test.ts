import { describe, expect, it } from "vitest"

import {
  EMPTY_CAPTURE,
  idCaptureProblem,
  idCheckForm,
  type IdCaptureValues,
} from "@/features/tradein/id-capture"

function good(patch: Partial<IdCaptureValues> = {}): IdCaptureValues {
  return {
    ...EMPTY_CAPTURE,
    idExpiry: "2031-06-30",
    idRefLast4: "4471",
    dob: "1994-03-18",
    address: "12 Castle Street, Bolsover, S44 6PP",
    attested: true,
    photo: new Blob(["x"], { type: "image/jpeg" }),
    ...patch,
  }
}

describe("idCaptureProblem", () => {
  it("passes a complete check", () => {
    expect(idCaptureProblem(good())).toBeNull()
  })

  it("asks for the photo first", () => {
    expect(idCaptureProblem(good({ photo: null }))).toMatch(/Photograph the ID/)
  })

  it("refuses an ID that has already expired", () => {
    expect(idCaptureProblem(good({ idExpiry: "2020-01-01" }))).toMatch(/expired/)
  })

  it("takes one to four digits, which is what the route accepts", () => {
    expect(idCaptureProblem(good({ idRefLast4: "44" }))).toBeNull()
    expect(idCaptureProblem(good({ idRefLast4: "" }))).toMatch(/last digits/)
    expect(idCaptureProblem(good({ idRefLast4: "44718" }))).toMatch(/last digits/)
  })

  it("refuses cash to someone under 18, with the reason", () => {
    const born = new Date()
    born.setFullYear(born.getFullYear() - 17)
    const problem = idCaptureProblem(good({ dob: born.toISOString().slice(0, 10) }))
    expect(problem).toMatch(/under 18/)
    expect(problem).toMatch(/store credit/)
  })

  it("insists on an address, because the register needs one", () => {
    expect(idCaptureProblem(good({ address: "  " }))).toMatch(/address/)
  })

  it("insists the staff member attests to having seen the document", () => {
    expect(idCaptureProblem(good({ attested: false }))).toMatch(/attestation/)
  })
})

describe("idCheckForm", () => {
  it("builds the multipart form the ID check route takes", () => {
    const form = idCheckForm(good())
    expect(form.get("id_type")).toBe("passport")
    expect(form.get("id_expiry")).toBe("2031-06-30")
    expect(form.get("id_ref_last4")).toBe("4471")
    expect(form.get("dob")).toBe("1994-03-18")
    expect(form.get("address")).toBe("12 Castle Street, Bolsover, S44 6PP")
    expect(form.get("photo")).toBeInstanceOf(Blob)
  })

  it("leaves the photo out when there is none, rather than sending an empty part", () => {
    expect(idCheckForm(good({ photo: null })).get("photo")).toBeNull()
  })
})
