import { describe, expect, it } from "vitest"
import { buildCode } from "@gg/shared"

import { labelLayout } from "@/features/labels/layout"
import {
  encodeTspl,
  escapeTspl,
  fitFont,
  POUND_BYTE,
  qrCell,
  qrModules,
  toPrintable,
  tsplBytes,
  tsplCommands,
  tsplLabel,
} from "@/features/printing/tspl"
import type { LabelJobDetail } from "@/lib/api/types"

/** The demo Charizard, the one every other suite prices at £324.99. */
const CARD = buildCode("single", "7F3K2")
const SLEEVE = buildCode("accessory", "4M2PT")
const CUSTOMER = buildCode("customer", "T6D1N")

const job: LabelJobDetail = {
  id: "job_1",
  status: "queued",
  copies: 1,
  template: "toploader_40x20",
  itemId: "item_1",
  code: CARD.encoded,
  title: "Charizard ex",
  detail: "SV151 199/165 Holo",
  condition: "NM",
  price: 32499,
  requestedAt: "2026-09-20T09:00:00Z",
}

describe("the top loader label", () => {
  it("is the commands the T003 takes, in dots", () => {
    expect(tsplCommands(labelLayout(job))).toEqual([
      "SIZE 40 mm,20 mm",
      "GAP 2 mm,0 mm",
      "DENSITY 8",
      "CODEPAGE 850",
      "CLS",
      `QRCODE 12,28,L,5,A,0,"${CARD.encoded}"`,
      'TEXT 129,39,"2",0,1,1,"Charizard ex"',
      'TEXT 129,64,"1",0,1,1,"SV151 199/165 Holo"',
      'TEXT 129,81,"1",0,1,1,"NM"',
      'TEXT 129,98,"3",0,1,1,"£324.99"',
      'TEXT 292,136,"1",0,1,1,"GG"',
      "PRINT 1,1",
    ])
  })

  it("ends every line with a carriage return and a line feed", () => {
    const text = tsplLabel(labelLayout(job))
    expect(text.startsWith("SIZE 40 mm,20 mm\r\n")).toBe(true)
    expect(text.endsWith("PRINT 1,1\r\n")).toBe(true)
    expect(text.split("\r\n").filter(Boolean)).toHaveLength(12)
  })

  it("prints the copies the job asks for", () => {
    const commands = tsplCommands(labelLayout(job), { copies: 3 })
    expect(commands.at(-1)).toBe("PRINT 1,3")
  })

  it("keeps the QR and the text inside the label", () => {
    const commands = tsplCommands(labelLayout(job))
    for (const command of commands) {
      const [x, y] = command
        .replace(/^(QRCODE|TEXT) /, "")
        .split(",")
        .map((part) => Number(part))
      if (!command.startsWith("QRCODE") && !command.startsWith("TEXT")) continue
      expect(x).toBeGreaterThanOrEqual(0)
      expect(x).toBeLessThan(320)
      expect(y).toBeGreaterThanOrEqual(0)
      expect(y).toBeLessThan(160)
    }
  })
})

describe("the sleeve label", () => {
  it("is a centred QR with the code under it, and no mark", () => {
    const sleeve = labelLayout({
      ...job,
      template: "sleeve_25x15",
      code: SLEEVE.encoded,
    })
    expect(tsplCommands(sleeve)).toEqual([
      "SIZE 25 mm,15 mm",
      "GAP 2 mm,0 mm",
      "DENSITY 8",
      "CODEPAGE 850",
      "CLS",
      `QRCODE 58,10,L,4,A,0,"${SLEEVE.encoded}"`,
      `TEXT 60,99,"1",0,1,1,"${SLEEVE.display}"`,
      "PRINT 1,1",
    ])
  })
})

describe("the customer card", () => {
  it("carries the portal link in the QR and the code in words", () => {
    const card = labelLayout({
      ...job,
      template: "customer_card_80x50",
      code: CUSTOMER.encoded,
      title: "Jasmine Okafor",
      detail: "Regular",
    })
    expect(tsplCommands(card, { copies: 2 })).toEqual([
      "SIZE 80 mm,50 mm",
      "GAP 2 mm,0 mm",
      "DENSITY 8",
      "CODEPAGE 850",
      "CLS",
      `QRCODE 12,84,L,8,A,0,"https://vault.ggentertainment.co.uk/c/${CUSTOMER.encoded}"`,
      'TEXT 256,151,"2",0,2,2,"Jasmine Okafor"',
      `TEXT 256,196,"3",0,1,1,"${CUSTOMER.display}"`,
      'TEXT 256,225,"3",0,1,1,"Regular"',
      'TEXT 612,376,"1",0,1,1,"GG"',
      "PRINT 1,2",
    ])
  })
})

describe("the bytes", () => {
  it("sends the pound sign as CP850's single byte", () => {
    const bytes = tsplBytes(labelLayout(job))
    expect(bytes.filter((byte) => byte === POUND_BYTE)).toHaveLength(1)
    // And the byte sits where the price line puts it.
    const text = tsplLabel(labelLayout(job))
    expect(bytes[text.indexOf("£")]).toBe(POUND_BYTE)
    expect(POUND_BYTE).toBe(0x9c)
  })

  it("is one byte per character, and nothing above ASCII but the pound", () => {
    const text = tsplLabel(labelLayout(job))
    const bytes = tsplBytes(labelLayout(job))
    expect(bytes).toHaveLength(text.length)
    for (const byte of bytes) {
      expect(byte === POUND_BYTE || byte < 0x80).toBe(true)
    }
  })

  it("names the code page that makes that byte a pound sign", () => {
    expect(tsplCommands(labelLayout(job))).toContain("CODEPAGE 850")
  })

  it("turns a stray character above ASCII into a question mark", () => {
    // Nothing the layout builds can reach here, so this is the guard, not
    // the everyday path.
    expect(Array.from(encodeTspl("A☃"))).toEqual([0x41, 0x3f])
  })
})

describe("escaping", () => {
  it("escapes the two characters TSPL reads as syntax", () => {
    expect(escapeTspl('Pokemon "Base Set" \\ 1999')).toBe(
      'Pokemon \\"Base Set\\" \\\\ 1999'
    )
  })

  it("drops control characters rather than sending them as commands", () => {
    expect(toPrintable("Charizard\r\nex\u0000")).toBe("Charizardex")
  })

  it("writes an accent, a middot and a curly quote in plain letters", () => {
    expect(toPrintable("Pokémon · Trainer’s")).toBe("Pokemon - Trainer's")
  })

  it("keeps the pound sign, which is the one byte above ASCII", () => {
    expect(toPrintable("£324.99")).toBe("£324.99")
  })

  it("puts a question mark where a character has no plain form", () => {
    expect(toPrintable("A☃B")).toBe("A?B")
  })
})

describe("fitting", () => {
  it("takes the built-in font nearest the height the layout asked for", () => {
    expect(fitFont(20)).toMatchObject({ font: { name: "2" }, multiplier: 1 })
    expect(fitFont(24)).toMatchObject({ font: { name: "3" }, multiplier: 1 })
  })

  it("prefers a bigger cell over a blown-up small one", () => {
    // 8 x 12 tripled is 36 dots and nearer 35 than 24 x 32 is, but it is the
    // coarser of the two, so the larger font wins.
    expect(fitFont(35)).toMatchObject({ font: { name: "4" }, multiplier: 1 })
  })

  it("comes in under the target when two choices are the same distance away", () => {
    // 12 and 20 are both four dots from 16.
    expect(fitFont(16)).toMatchObject({ font: { name: "1" }, multiplier: 1 })
  })

  it("sizes the QR cell so the symbol lands on the spec's millimetres", () => {
    // A nine-character code is a version 1 symbol: 21 modules at 5 dots is
    // 105 of the 110 the spec asks for on a 40 x 20 label.
    expect(qrModules(CARD.encoded)).toBe(21)
    expect(qrCell(CARD.encoded, 110)).toBe(5)
    // A portal link is longer, so the symbol is bigger and the cell smaller.
    expect(qrModules(`https://vault.ggentertainment.co.uk/c/${CUSTOMER.encoded}`)).toBe(29)
  })
})
