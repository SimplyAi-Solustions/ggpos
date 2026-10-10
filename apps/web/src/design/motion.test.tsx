import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, render, screen } from "@testing-library/react"

import { useCountUp, useScanPulse } from "@/design/motion"

/**
 * The reduced-motion branch of these hooks is the one nobody sees by hand, so
 * it is the one worth a test: a reader who has asked for no motion has no
 * count-up to make a starting zero read as a starting point, and would take a
 * frame of £0.00 on a money tile as the day's takings.
 *
 * jsdom has no `matchMedia`, so every test sets one. Plain DOM assertions
 * rather than jest-dom matchers, the way `MoneyField.test.tsx` does it: this
 * package has no vitest setup file.
 */
function setReducedMotion(reduced: boolean) {
  vi.stubGlobal(
    "matchMedia",
    (query: string): MediaQueryList =>
      ({
        media: query,
        matches: query.includes("prefers-reduced-motion") ? reduced : false,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList
  )
}

/** The shape of Home's tile: "-" until the figure lands, then the figure. */
function Tile({ pence, counted }: { pence: number; counted: boolean }) {
  const shown = useCountUp(counted ? pence : 0)
  return <span data-testid="figure">{counted ? shown : "-"}</span>
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("useCountUp under reduced motion", () => {
  beforeEach(() => setReducedMotion(true))

  it("never paints a frame of the seeded zero when the figure arrives", () => {
    const { rerender } = render(<Tile pence={0} counted={false} />)
    expect(screen.getByTestId("figure").textContent).toBe("-")

    // The render in which the figures land. Before the fix the value was only
    // corrected in an effect, so this render returned the seeded 0 and a
    // money tile showed £0.00 for a frame.
    rerender(<Tile pence={4994} counted={true} />)
    expect(screen.getByTestId("figure").textContent).toBe("4994")
  })

  it("follows a later figure straight away", () => {
    const { rerender } = render(<Tile pence={4994} counted={true} />)
    rerender(<Tile pence={8500} counted={true} />)
    expect(screen.getByTestId("figure").textContent).toBe("8500")
  })
})

describe("useCountUp with motion allowed", () => {
  beforeEach(() => setReducedMotion(false))

  it("lands on the figure it was given", async () => {
    // How many frames the count takes is the animation runner's business and
    // differs between jsdom and a browser; where it stops is not.
    const { rerender } = render(<Tile pence={0} counted={false} />)
    rerender(<Tile pence={4994} counted={true} />)

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 900))
    })
    expect(screen.getByTestId("figure").textContent).toBe("4994")
  })

  it("holds its width by returning whole pence, so tnum has nothing to shift", () => {
    render(<Tile pence={4994} counted={true} />)
    expect(screen.getByTestId("figure").textContent).toMatch(/^\d+$/)
  })
})

/** Reads back what `useScanPulse` hands a screen. */
function Pulsed({ scans }: { scans: string[] }) {
  const [pulsing, pulse] = useScanPulse()
  return (
    <>
      <span data-testid="pulsing">{pulsing ? `${pulsing.id}:${pulsing.nonce}` : "none"}</span>
      <button
        onClick={() => {
          for (const id of scans) pulse(id)
        }}
      >
        Scan
      </button>
    </>
  )
}

describe("useScanPulse", () => {
  beforeEach(() => setReducedMotion(false))

  it("says nothing is flashing before a scan", () => {
    render(<Pulsed scans={[]} />)
    expect(screen.getByTestId("pulsing").textContent).toBe("none")
  })

  it("flashes the row a scan landed on", () => {
    render(<Pulsed scans={["item_a"]} />)
    act(() => screen.getByRole("button").click())
    expect(screen.getByTestId("pulsing").textContent).toBe("item_a:1")
  })

  it("raises the nonce when the same line is scanned again", () => {
    // Three of the same sealed box. The id cannot tell React anything
    // changed, so without the nonce the second and third scans do not flash.
    render(<Pulsed scans={["item_a"]} />)
    const button = screen.getByRole("button")
    act(() => button.click())
    act(() => button.click())
    act(() => button.click())
    expect(screen.getByTestId("pulsing").textContent).toBe("item_a:3")
  })

  it("moves to the next row and keeps counting", () => {
    render(<Pulsed scans={["item_a"]} />)
    act(() => screen.getByRole("button").click())
    cleanup()
    render(<Pulsed scans={["item_a", "item_b"]} />)
    act(() => screen.getByRole("button").click())
    expect(screen.getByTestId("pulsing").textContent).toBe("item_b:2")
  })

  it("stops flashing once the hold is over", async () => {
    vi.useFakeTimers()
    try {
      render(<Pulsed scans={["item_a"]} />)
      act(() => screen.getByRole("button").click())
      expect(screen.getByTestId("pulsing").textContent).toBe("item_a:1")
      act(() => vi.advanceTimersByTime(1000))
      expect(screen.getByTestId("pulsing").textContent).toBe("none")
    } finally {
      vi.useRealTimers()
    }
  })
})
