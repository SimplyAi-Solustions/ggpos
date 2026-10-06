import { describe, expect, it } from "vitest"
import {
  eposCardNumberOf,
  eposCustomerBody,
  eposCustomerIdFrom,
  eposTimestampToIso,
  eposTransactionsFrom,
  guildSaleIn,
  isCompletedSale,
  normaliseProductIds,
  readEposTransaction,
  splitName,
} from "../src/eposnow"

// The shape GET v4/Transaction/GetByDate answers with (camelCase, a bare
// array), trimmed to the fields this integration reads.
const V4_PAGE = [
  {
    id: 50001,
    customerId: 7001,
    dateTime: "2026-10-06T14:30:00",
    statusId: 1,
    totalAmount: 26.5,
    transactionItems: [
      { productId: 9001, unitPrice: 24, quantity: 1, discountAmount: null },
      { productId: 1234, unitPrice: 2.5, quantity: 1 },
    ],
    tenders: [{ tenderTypeId: 1, amount: 26.5 }],
  },
  {
    id: 50002,
    customerId: null,
    dateTime: "2026-10-06T15:00:00",
    statusId: 1,
    transactionItems: [{ productId: 1234, unitPrice: 4.99, quantity: 2 }],
  },
]

// The older PascalCase shape a webhook may carry.
const WEBHOOK = {
  TransactionID: 50003,
  CustomerID: 7002,
  DateTime: "2026-10-06 16:05:10",
  TransactionItems: [{ ProductID: "9001", UnitPrice: "24.00", Quantity: 1, DiscountAmount: "4.00" }],
}

describe("eposTimestampToIso", () => {
  it("reads a zone-less Epos Now time as UTC", () => {
    expect(eposTimestampToIso("2026-10-06T14:30:00")).toBe("2026-10-06T14:30:00.000Z")
    expect(eposTimestampToIso("2026-10-06 14:30:00")).toBe("2026-10-06T14:30:00.000Z")
    expect(eposTimestampToIso("2026-10-06")).toBe("2026-10-06T00:00:00.000Z")
  })
  it("keeps a zone that is given", () => {
    expect(eposTimestampToIso("2026-10-06T15:30:00+01:00")).toBe("2026-10-06T14:30:00.000Z")
  })
  it("returns null for nothing readable", () => {
    expect(eposTimestampToIso("")).toBeNull()
    expect(eposTimestampToIso("soon")).toBeNull()
    expect(eposTimestampToIso(42)).toBeNull()
  })
})

describe("reading transactions", () => {
  it("reads the v4 list shape into pence", () => {
    const txs = eposTransactionsFrom(V4_PAGE)
    expect(txs).toHaveLength(2)
    expect(txs[0]).toMatchObject({
      id: "50001",
      customerId: "7001",
      soldAt: "2026-10-06T14:30:00.000Z",
      statusId: 1,
    })
    expect(txs[0]?.lines[0]).toEqual({
      productId: "9001",
      quantity: 1,
      unitPence: 2400,
      discountPence: 0,
      amountPence: 2400,
    })
    expect(txs[1]?.customerId).toBe("")
    expect(txs[1]?.lines[0]?.amountPence).toBe(998)
  })

  it("reads the PascalCase webhook shape, discount and all", () => {
    const [tx] = eposTransactionsFrom(WEBHOOK)
    expect(tx).toMatchObject({ id: "50003", customerId: "7002", statusId: null })
    expect(tx?.soldAt).toBe("2026-10-06T16:05:10.000Z")
    expect(tx?.lines[0]?.amountPence).toBe(2000)
  })

  it("unwraps a payload carried inside an envelope", () => {
    expect(eposTransactionsFrom({ Data: WEBHOOK })[0]?.id).toBe("50003")
    expect(eposTransactionsFrom({ transactions: V4_PAGE })).toHaveLength(2)
  })

  it("treats a customer id of 0 as nobody", () => {
    expect(readEposTransaction({ id: 1, customerId: 0, transactionItems: [] })?.customerId).toBe("")
  })

  it("drops what cannot be named", () => {
    expect(eposTransactionsFrom([{ customerId: 1 }, null, "x"])).toEqual([])
    expect(eposTransactionsFrom(null)).toEqual([])
  })
})

describe("guildSaleIn", () => {
  const [first, second] = eposTransactionsFrom(V4_PAGE)

  it("adds up the Guild lines only", () => {
    expect(guildSaleIn(first!, [9001])).toEqual({ quantity: 1, amountPence: 2400 })
    expect(guildSaleIn(first!, ["9001", "1234"])).toEqual({ quantity: 2, amountPence: 2650 })
  })

  it("is null when no Guild product was sold, or none is set up", () => {
    expect(guildSaleIn(second!, [9001])).toBeNull()
    expect(guildSaleIn(first!, [])).toBeNull()
    expect(guildSaleIn(first!, "9001")).toBeNull()
  })

  it("leaves a refunded line out", () => {
    const refund = readEposTransaction({
      id: 9,
      transactionItems: [{ productId: 9001, unitPrice: 24, quantity: -1 }],
    })
    expect(guildSaleIn(refund!, [9001])).toBeNull()
  })

  it("never lets a discount take a line below nothing", () => {
    const tx = readEposTransaction({
      id: 10,
      transactionItems: [{ productId: 9001, unitPrice: 24, quantity: 1, discountAmount: 30 }],
    })
    expect(guildSaleIn(tx!, [9001])).toEqual({ quantity: 1, amountPence: 0 })
  })
})

describe("isCompletedSale", () => {
  it("accepts status 1, and a payload that does not say", () => {
    expect(isCompletedSale(readEposTransaction({ id: 1, statusId: 1 })!)).toBe(true)
    expect(isCompletedSale(readEposTransaction({ id: 1 })!)).toBe(true)
    expect(isCompletedSale(readEposTransaction({ id: 1, statusId: 3 })!)).toBe(false)
  })
})

describe("normaliseProductIds", () => {
  it("keeps distinct ids as text", () => {
    expect(normaliseProductIds([9001, "9001", " 42 ", "", null])).toEqual(["9001", "42"])
    expect(normaliseProductIds(undefined)).toEqual([])
  })
})

describe("customers", () => {
  it("splits a name for the forename and surname fields", () => {
    expect(splitName("Sam de la Cruz")).toEqual({ forename: "Sam", surname: "de la Cruz" })
    expect(splitName("Cher")).toEqual({ forename: "Cher", surname: "" })
    expect(splitName("  ")).toEqual({ forename: "Customer", surname: "" })
  })

  it("builds the create body with the code as the card number and nothing more", () => {
    const [body] = eposCustomerBody({
      name: "Alex Fields",
      email: "alex@example.co.uk",
      code: "GGC7F3K2Q",
      marketingConsent: true,
      locationId: 14037,
    })
    expect(body).toEqual({
      forename: "Alex",
      surname: "Fields",
      emailAddress: "alex@example.co.uk",
      cardNumber: "GGC7F3K2Q",
      signUpLocationId: 14037,
      marketingConsent: { email: true, text: false, phone: false, mail: false },
    })
  })

  it("leaves out an email address longer than Epos Now accepts", () => {
    const [body] = eposCustomerBody({
      name: "Alex",
      email: `${"a".repeat(45)}@example.co.uk`,
      code: "GGC7F3K2Q",
      marketingConsent: false,
    })
    expect(body?.emailAddress).toBeUndefined()
  })

  it("reads the id and card number back off an answer", () => {
    expect(eposCustomerIdFrom([{ id: 7001, cardNumber: "GGC7F3K2Q" }])).toBe("7001")
    expect(eposCustomerIdFrom({ Id: "7002" })).toBe("7002")
    expect(eposCustomerIdFrom([])).toBe("")
    expect(eposCardNumberOf({ CardNumber: " GGC7F3K2Q " })).toBe("GGC7F3K2Q")
  })
})
