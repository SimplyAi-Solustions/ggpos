import { afterEach, describe, expect, it } from "vitest"

import { listReaders, pairReader, removeReader } from "@/lib/api/demo/checkouts"

/**
 * What is left of the demo Solo reader: the pairing calls Settings > Card
 * reader still makes until that section goes. No payment is ever taken on
 * it any more; the till keys card payments on the Tide reader.
 */

function reader(mode: string) {
  if (mode) localStorage.setItem("gg-demo-reader", mode)
  else localStorage.removeItem("gg-demo-reader")
}

afterEach(() => reader(""))

describe("the demo reader's pairing", () => {
  it("lists the reader the shop has paired", () => {
    const list = listReaders()
    expect(list.not_configured).toBe(false)
    expect(list.readers[0]?.name).toBe("Counter Solo")
  })

  it("says SumUp is not set up at all", () => {
    reader("off")
    expect(listReaders()).toEqual({ readers: [], default_reader_id: "", not_configured: true })
  })

  it("says nothing is paired", () => {
    reader("unpaired")
    expect(listReaders().readers).toHaveLength(0)
  })

  it("refuses a pairing code of the wrong length", () => {
    expect(() => pairReader("ABC")).toThrow("That pairing code was not accepted.")
  })

  it("pairs a reader and takes it away again", () => {
    const paired = pairReader("ABCD1234", "Back room")
    expect(listReaders().readers.some((row) => row.id === paired.id)).toBe(true)
    removeReader(paired.id)
    expect(listReaders().readers.some((row) => row.id === paired.id)).toBe(false)
  })
})
