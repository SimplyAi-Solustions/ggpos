import { fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { CardArt, finishKind, REDUCED_MOTION_QUERY } from "./CardArt"

function setReducedMotion(reduced: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === REDUCED_MOTION_QUERY ? reduced : false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }))
}

/** A card 100 by 140 at the top left, so pointer positions are easy sums. */
function sized(el: HTMLElement) {
  vi.spyOn(el, "getBoundingClientRect").mockReturnValue({
    left: 0,
    top: 0,
    right: 100,
    bottom: 140,
    width: 100,
    height: 140,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect)
  return el
}

beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    cb(0)
    return 1
  })
  vi.stubGlobal("cancelAnimationFrame", () => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("finishKind", () => {
  it("folds catalogue finish strings into three looks", () => {
    expect(finishKind("holofoil")).toBe("holo")
    expect(finishKind("1stEditionHolofoil")).toBe("holo")
    expect(finishKind("reverseHolofoil")).toBe("reverse")
    expect(finishKind("Reverse holo")).toBe("reverse")
    expect(finishKind("normal")).toBe("normal")
    expect(finishKind("")).toBe("normal")
    expect(finishKind(undefined)).toBe("normal")
  })
})

describe("CardArt", () => {
  it("names the card and draws the holo shine for a holo finish", () => {
    setReducedMotion(false)
    const { container } = render(<CardArt src="/c.png" alt="Charizard ex 199" finish="holofoil" />)
    const art = screen.getByRole("img", { name: "Charizard ex 199" })
    expect(art).toHaveAttribute("data-finish", "holo")
    expect(art).toHaveAttribute("data-motion", "full")
    expect(container.querySelector(".ca-holo")).not.toBeNull()
    expect(container.querySelector(".ca-sweep")).not.toBeNull()
  })

  it("has no shine on a normal finish", () => {
    setReducedMotion(false)
    const { container } = render(<CardArt src="/c.png" alt="Pikachu" finish="normal" />)
    expect(container.querySelector(".ca-holo")).toBeNull()
    expect(container.querySelector(".ca-sweep")).toBeNull()
  })

  it("tilts towards the pointer when motion is allowed", () => {
    setReducedMotion(false)
    render(<CardArt src="/c.png" alt="Mew" finish="holo" maxTilt={10} />)
    const art = sized(screen.getByRole("img", { name: "Mew" }))
    fireEvent.pointerMove(art, { clientX: 100, clientY: 70, pointerType: "mouse" })
    expect(art.style.getPropertyValue("--ca-ry")).toBe("10.00deg")
    expect(art.dataset.active).toBe("true")
    fireEvent.pointerLeave(art)
    expect(art.style.getPropertyValue("--ca-ry")).toBe("0.00deg")
  })

  it("stays still under reduced motion but keeps the holo shine", () => {
    setReducedMotion(true)
    const { container } = render(<CardArt src="/c.png" alt="Mew" finish="holo" gyro />)
    const art = sized(screen.getByRole("img", { name: "Mew" }))
    expect(art).toHaveAttribute("data-motion", "reduced")
    expect(art.className).not.toContain("ca-tilt")
    fireEvent.pointerMove(art, { clientX: 100, clientY: 0, pointerType: "touch" })
    expect(art.style.getPropertyValue("--ca-ry")).toBe("")
    expect(art.dataset.active).toBeUndefined()
    // The finish still reads, but the sweep does not play.
    expect(container.querySelector(".ca-holo")).not.toBeNull()
    expect(container.querySelector(".ca-sweep")).toBeNull()
  })

  it("listens to the gyro only when motion is allowed", () => {
    class FakeOrientation extends Event {}
    vi.stubGlobal("DeviceOrientationEvent", FakeOrientation)
    const add = vi.spyOn(window, "addEventListener")

    setReducedMotion(true)
    const first = render(<CardArt src="/c.png" alt="Mew" gyro />)
    expect(add.mock.calls.some(([type]) => type === "deviceorientation")).toBe(false)
    expect(screen.getByRole("img", { name: "Mew" })).toHaveAttribute("data-gyro", "off")
    first.unmount()

    setReducedMotion(false)
    render(<CardArt src="/c.png" alt="Mew" gyro />)
    expect(add.mock.calls.some(([type]) => type === "deviceorientation")).toBe(true)
    expect(screen.getByRole("img", { name: "Mew" })).toHaveAttribute("data-gyro", "on")
  })

  it("waits for a tap and a yes before using the iPhone gyro", async () => {
    const requestPermission = vi.fn().mockResolvedValue("granted")
    class FakeOrientation extends Event {
      static requestPermission = requestPermission
    }
    vi.stubGlobal("DeviceOrientationEvent", FakeOrientation)
    setReducedMotion(false)
    render(<CardArt src="/c.png" alt="Mew" gyro />)
    const art = screen.getByRole("img", { name: "Mew" })
    expect(art).toHaveAttribute("data-gyro", "off")
    fireEvent.pointerUp(art)
    expect(requestPermission).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(art).toHaveAttribute("data-gyro", "on"))
  })

  it("shows the fallback when the picture is missing", () => {
    setReducedMotion(false)
    render(<CardArt alt="Sealed box" fallback={<span>Box icon</span>} />)
    expect(screen.getByText("Box icon")).toBeInTheDocument()
  })
})
