import { afterEach, describe, expect, it } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"

import { Field } from "@/components/ui/field"

/**
 * `Field` is the only form layout in the app, so the one thing worth
 * pinning down here is the wiring it does for a screen reader: an error
 * has to be announced as belonging to the control it sits under, not just
 * drawn beneath it. Everything else about the component is layout, which
 * the reference screens and the e2e cover.
 *
 * Plain DOM assertions rather than jest-dom matchers, matching the other
 * component tests in this package: there is no vitest setup file.
 */
afterEach(cleanup)

describe("Field", () => {
  it("leaves the control alone when there is nothing wrong", () => {
    render(
      <Field label="Email" htmlFor="email">
        <input id="email" />
      </Field>
    )

    const control = screen.getByLabelText("Email")
    expect(control.getAttribute("aria-describedby")).toBeNull()
  })

  it("points the control at the message when there is one", () => {
    render(
      <Field label="Email" htmlFor="email" error="That is not an email address.">
        <input id="email" />
      </Field>
    )

    const control = screen.getByLabelText("Email")
    const describedBy = control.getAttribute("aria-describedby")
    expect(describedBy).toBeTruthy()

    const message = document.getElementById(describedBy!)
    expect(message?.textContent).toBe("That is not an email address.")
    expect(message?.getAttribute("role")).toBe("alert")
  })

  it("keeps a description the control already had", () => {
    render(
      <Field label="Email" htmlFor="email" error="That is not an email address.">
        <input id="email" aria-describedby="email-note" />
      </Field>
    )

    const ids = screen.getByLabelText("Email").getAttribute("aria-describedby")!.split(" ")
    expect(ids[0]).toBe("email-note")
    expect(ids).toHaveLength(2)
  })

  it("leaves a fragment child alone, which takes no props of its own", () => {
    render(
      <Field label="Amount" error="Too much.">
        <>
          <input aria-label="Pounds" />
        </>
      </Field>
    )

    expect(screen.getByLabelText("Pounds").getAttribute("aria-describedby")).toBeNull()
    expect(screen.getByText("Too much.")).toBeTruthy()
  })

  it("renders a field holding more than one child unchanged", () => {
    render(
      <Field label="Amount" error="Too much.">
        <input aria-label="Pounds" />
        <input aria-label="Pence" />
      </Field>
    )

    expect(screen.getByLabelText("Pounds").getAttribute("aria-describedby")).toBeNull()
    expect(screen.getByLabelText("Pence").getAttribute("aria-describedby")).toBeNull()
    expect(screen.getByText("Too much.")).toBeTruthy()
  })
})
