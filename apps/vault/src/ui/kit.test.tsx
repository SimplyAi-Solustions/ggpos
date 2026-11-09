import * as React from "react"
import { describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { Badge, Button, Chip, EmptyState, IconButton, Money, MoneyInput, PercentStepper, Segmented, Sheet, ToastProvider, useToast } from "@/ui"
import { clampPercent } from "@/ui/PercentStepper"
import { penceToPlain } from "@/ui/MoneyInput"

describe("Money", () => {
  it("formats pence as pounds with the shared helper", () => {
    render(<Money pence={123456} />)
    expect(screen.getByText("£1,234.56")).toBeInTheDocument()
  })

  it("shows sub-pound values as £0.45", () => {
    render(<Money pence={45} />)
    expect(screen.getByText("£0.45")).toBeInTheDocument()
  })

  it("gives screen readers the final figure when tweening", () => {
    render(<Money pence={5000} tween />)
    expect(screen.getAllByText("£50.00").length).toBeGreaterThan(0)
  })
})

describe("penceToPlain", () => {
  it("uses integer maths", () => {
    expect(penceToPlain(1234)).toBe("12.34")
    expect(penceToPlain(5)).toBe("0.05")
    expect(penceToPlain(-250)).toBe("-2.50")
  })
})

function MoneyHarness({ onChange }: { onChange: (v: number | null) => void }) {
  const [value, setValue] = React.useState<number | null>(null)
  return (
    <MoneyInput
      label="Market value"
      value={value}
      onChange={(v) => {
        setValue(v)
        onChange(v)
      }}
    />
  )
}

describe("MoneyInput", () => {
  it("turns typed pounds into pence and formats on blur", async () => {
    const onChange = vi.fn()
    render(<MoneyHarness onChange={onChange} />)
    const input = screen.getByLabelText("Market value")
    await userEvent.type(input, "1234.5")
    expect(onChange).toHaveBeenLastCalledWith(123450)
    await userEvent.tab()
    expect(input).toHaveValue("1,234.50")
  })

  it("explains an amount it cannot read", async () => {
    render(<MoneyHarness onChange={() => {}} />)
    await userEvent.type(screen.getByLabelText("Market value"), "12.345")
    expect(screen.getByRole("alert")).toHaveTextContent("Enter an amount like 12.50.")
  })

  it("empties to null", async () => {
    const onChange = vi.fn()
    render(<MoneyHarness onChange={onChange} />)
    const input = screen.getByLabelText("Market value")
    await userEvent.type(input, "5")
    await userEvent.clear(input)
    expect(onChange).toHaveBeenLastCalledWith(null)
  })
})

describe("PercentStepper", () => {
  it("clamps and rounds", () => {
    expect(clampPercent(120, 0, 100)).toBe(100)
    expect(clampPercent(-3, 0, 100)).toBe(0)
    expect(clampPercent(54.6, 0, 100)).toBe(55)
  })

  it("steps with the buttons and accepts a typed value", async () => {
    function Harness() {
      const [v, setV] = React.useState(50)
      return <PercentStepper label="Cash rate" value={v} onChange={setV} />
    }
    render(<Harness />)
    await userEvent.click(screen.getByRole("button", { name: "Increase Cash rate" }))
    expect(screen.getByLabelText("Cash rate")).toHaveValue("55")
    await userEvent.click(screen.getByRole("button", { name: "Decrease Cash rate" }))
    await userEvent.click(screen.getByRole("button", { name: "Decrease Cash rate" }))
    expect(screen.getByLabelText("Cash rate")).toHaveValue("45")
    const input = screen.getByLabelText("Cash rate")
    await userEvent.clear(input)
    await userEvent.type(input, "140{Enter}")
    expect(input).toHaveValue("100")
  })
})

describe("Segmented", () => {
  it("is a radio group that moves with arrow keys", async () => {
    function Harness() {
      const [v, setV] = React.useState<"cash" | "credit">("cash")
      return (
        <Segmented
          label="Pay out as"
          value={v}
          onChange={setV}
          options={[
            { value: "cash", label: "Cash" },
            { value: "credit", label: "Trade credit" },
          ]}
        />
      )
    }
    render(<Harness />)
    expect(screen.getByRole("radio", { name: "Cash" })).toHaveAttribute("aria-checked", "true")
    screen.getByRole("radio", { name: "Cash" }).focus()
    await userEvent.keyboard("{ArrowRight}")
    expect(screen.getByRole("radio", { name: "Trade credit" })).toHaveAttribute("aria-checked", "true")
  })
})

describe("Buttons and small pieces", () => {
  it("disables a loading button", () => {
    render(<Button loading>Save</Button>)
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled()
  })

  it("names an icon button", () => {
    render(<IconButton label="Close">x</IconButton>)
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument()
  })

  it("reports a chip's pressed state", () => {
    render(<Chip selected>Holo</Chip>)
    expect(screen.getByRole("button", { name: "Holo" })).toHaveAttribute("aria-pressed", "true")
  })

  it("renders a badge and an empty state", () => {
    render(
      <>
        <Badge tone="ok">Ready</Badge>
        <EmptyState title="No deals yet">Start one from Scan.</EmptyState>
      </>
    )
    expect(screen.getByText("Ready")).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "No deals yet" })).toBeInTheDocument()
  })
})

describe("Sheet", () => {
  it("opens as a dialog and closes on Escape", async () => {
    const onClose = vi.fn()
    render(
      <Sheet open onClose={onClose} title="Condition">
        Pick one
      </Sheet>
    )
    expect(screen.getByRole("dialog", { name: "Condition" })).toBeInTheDocument()
    await userEvent.keyboard("{Escape}")
    expect(onClose).toHaveBeenCalled()
  })
})

describe("Toast", () => {
  it("announces a message", async () => {
    function Trigger() {
      const toast = useToast()
      return <button onClick={() => toast({ message: "Deal saved.", tone: "ok" })}>Go</button>
    }
    render(
      <ToastProvider>
        <Trigger />
      </ToastProvider>
    )
    await userEvent.click(screen.getByRole("button", { name: "Go" }))
    expect(screen.getByRole("status")).toHaveTextContent("Deal saved.")
  })
})
