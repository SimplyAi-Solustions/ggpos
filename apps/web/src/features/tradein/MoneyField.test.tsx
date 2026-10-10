import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { MoneyField } from "@/features/tradein/MoneyField"

/**
 * The money box is where a buy-in's figures are typed, so what it reports
 * and what it shows have to agree. Everything here is in pence, because
 * everything GG Vault stores is.
 *
 * Plain DOM assertions rather than jest-dom matchers: this package has no
 * vitest setup file, and one test is not a reason to add one to a config
 * three packages share.
 */
function setup(initial = 0) {
  const onChange = vi.fn()
  render(
    <MoneyField id="amount" label="Amount" value={initial} onChange={onChange} />
  )
  return {
    field: screen.getByLabelText("Amount") as HTMLInputElement,
    onChange,
  }
}

afterEach(cleanup)

describe("MoneyField", () => {
  it("reads whole pounds", async () => {
    const { field, onChange } = setup()
    await userEvent.type(field, "12")
    expect(onChange).toHaveBeenLastCalledWith(1200)
  })

  it("reads one decimal place as tenths of a pound", async () => {
    const { field, onChange } = setup()
    await userEvent.type(field, "12.5")
    expect(onChange).toHaveBeenLastCalledWith(1250)
  })

  it("reads two decimal places", async () => {
    const { field, onChange } = setup()
    await userEvent.type(field, "12.50")
    expect(onChange).toHaveBeenLastCalledWith(1250)
  })

  it("reads an amount typed with its pound sign", async () => {
    const { field, onChange } = setup()
    await userEvent.type(field, "£12.50")
    expect(onChange).toHaveBeenLastCalledWith(1250)
  })

  it("tidies what is in the box when it is left", async () => {
    const { field } = setup()
    await userEvent.type(field, "12.5")
    await userEvent.tab()
    expect(field.value).toBe("12.50")
  })

  it("reports nothing for an empty box", async () => {
    const { field, onChange } = setup(1250)
    await userEvent.clear(field)
    expect(onChange).toHaveBeenLastCalledWith(0)
  })

  it("marks an unreadable amount invalid rather than ignoring it", async () => {
    const { field } = setup()
    await userEvent.type(field, ",")
    expect(field.getAttribute("aria-invalid")).toBe("true")
  })

  it("puts back the last good figure when an unreadable one is left", async () => {
    const { field, onChange } = setup()
    await userEvent.type(field, "12.50")
    onChange.mockClear()
    await userEvent.type(field, "abc")
    await userEvent.tab()
    expect(field.value).toBe("12.50")
    expect(field.getAttribute("aria-invalid")).toBeNull()
    // Nothing new was reported: the figure never silently changed.
    expect(onChange).not.toHaveBeenCalled()
  })

  it("refuses three decimal places rather than rounding them itself", async () => {
    const { field, onChange } = setup()
    await userEvent.type(field, "12.505")
    // The third digit makes it unreadable, so nothing new is reported and
    // leaving the field puts back the two-decimal figure that was.
    expect(field.getAttribute("aria-invalid")).toBe("true")
    expect(onChange).toHaveBeenLastCalledWith(1250)
    await userEvent.tab()
    expect(field.value).toBe("12.50")
  })
})
