import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import * as React from "react"

const routeId = { current: "/counter/reports/$key" }

// The whole of `PageMain`'s router use is one selector, so the router is
// stubbed rather than mounted: a real `RouterProvider` would bring the route
// tree, the loaders and the query client into a test about one landmark.
vi.mock("@tanstack/react-router", () => ({
  useRouterState: ({ select }: { select: (state: unknown) => string }) =>
    select({ matches: [{ routeId: "/counter" }, { routeId: routeId.current }] }),
}))

const { PageMain } = await import("@/app/page-transition")

/** Counts how many times it was mounted, so a remount is visible. */
function Mounted({ onMount }: { onMount: () => void }) {
  React.useEffect(onMount, [onMount])
  return <p>Screen</p>
}

beforeEach(() => {
  routeId.current = "/counter/reports/$key"
  vi.stubGlobal(
    "matchMedia",
    (query: string) =>
      ({
        media: query,
        matches: false,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("PageMain", () => {
  it("renders the landmark itself, with the id and classes untouched", () => {
    render(
      <PageMain id="counter-main" className="mx-auto max-w-[1040px]">
        <p>Screen</p>
      </PageMain>
    )
    const main = screen.getByRole("main")
    expect(main.tagName).toBe("MAIN")
    expect(main.id).toBe("counter-main")
    expect(main.className).toContain("max-w-[1040px]")
    // Nothing is added between the column and the screen.
    expect(main.firstElementChild?.tagName).toBe("P")
  })

  it("plays again when the matched route changes", () => {
    const onMount = vi.fn()
    const { rerender } = render(
      <PageMain>
        <Mounted onMount={onMount} />
      </PageMain>
    )
    expect(onMount).toHaveBeenCalledTimes(1)

    routeId.current = "/counter/stock"
    rerender(
      <PageMain>
        <Mounted onMount={onMount} />
      </PageMain>
    )
    expect(onMount).toHaveBeenCalledTimes(2)
  })

  it("leaves the screen alone when only a param moves", () => {
    // One report to another is the same route id. Keying on the pathname
    // would remount here and lose anything half typed on the item page.
    const onMount = vi.fn()
    const { rerender } = render(
      <PageMain>
        <Mounted onMount={onMount} />
      </PageMain>
    )
    rerender(
      <PageMain>
        <Mounted onMount={onMount} />
      </PageMain>
    )
    expect(onMount).toHaveBeenCalledTimes(1)
  })
})
