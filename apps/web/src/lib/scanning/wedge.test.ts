import { afterEach, describe, expect, it, vi } from "vitest"

import { createWedgeListener } from "@/lib/scanning/wedge"

/** A clock the test moves by hand, so "fast" and "slow" are not wall time. */
function clock(start = 1_000) {
  let value = start
  return {
    now: () => value,
    tick(ms: number) {
      value += ms
    },
  }
}

function press(target: Element, key: string) {
  target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }))
}

function type(target: Element, text: string, time: ReturnType<typeof clock>, gap = 10) {
  for (const character of text) {
    time.tick(gap)
    press(target, character)
  }
}

let stop: (() => void) | null = null

afterEach(() => {
  stop?.()
  stop = null
  document.body.innerHTML = ""
})

describe("createWedgeListener", () => {
  it("commits a fast burst of keystrokes on Enter", () => {
    const onScan = vi.fn()
    const time = clock()
    stop = createWedgeListener({ onScan, now: time.now })

    type(document.body, "GGS7F3K2Q", time)
    press(document.body, "Enter")

    expect(onScan).toHaveBeenCalledExactlyOnceWith("GGS7F3K2Q")
  })

  it("drops a buffer typed too slowly to be a scanner", () => {
    const onScan = vi.fn()
    const time = clock()
    stop = createWedgeListener({ onScan, now: time.now })

    type(document.body, "GGS7F3K2Q", time, 120)
    press(document.body, "Enter")

    expect(onScan).not.toHaveBeenCalled()
  })

  it("ignores a burst shorter than the minimum length", () => {
    const onScan = vi.fn()
    const time = clock()
    stop = createWedgeListener({ onScan, now: time.now })

    type(document.body, "GGS12", time)
    press(document.body, "Enter")

    expect(onScan).not.toHaveBeenCalled()
  })

  it("ignores a bare Enter with nothing buffered", () => {
    const onScan = vi.fn()
    stop = createWedgeListener({ onScan, now: clock().now })

    press(document.body, "Enter")

    expect(onScan).not.toHaveBeenCalled()
  })

  it("strips a configured prefix character", () => {
    const onScan = vi.fn()
    const time = clock()
    stop = createWedgeListener({ onScan, prefix: "*", now: time.now })

    type(document.body, "*GGS7F3K2Q", time)
    press(document.body, "Enter")

    expect(onScan).toHaveBeenCalledExactlyOnceWith("GGS7F3K2Q")
  })

  it("drops a scan that is missing the configured prefix", () => {
    const onScan = vi.fn()
    const time = clock()
    stop = createWedgeListener({ onScan, prefix: "*", now: time.now })

    type(document.body, "GGS7F3K2Q", time)
    press(document.body, "Enter")

    expect(onScan).not.toHaveBeenCalled()
  })

  it("stays out of the way while another text field has focus", () => {
    const onScan = vi.fn()
    const time = clock()
    const field = document.createElement("input")
    document.body.append(field)
    stop = createWedgeListener({ onScan, now: time.now })

    type(field, "GGS7F3K2Q", time)
    press(field, "Enter")

    expect(onScan).not.toHaveBeenCalled()
  })

  it("commits the scan field's own value on Enter, however slowly it was typed", () => {
    const onScan = vi.fn()
    const time = clock()
    const field = document.createElement("input")
    field.value = " ggs-7f3k2q "
    document.body.append(field)
    stop = createWedgeListener({
      onScan,
      now: time.now,
      isScanField: (element) => element === field,
    })

    press(field, "Enter")

    expect(onScan).toHaveBeenCalledExactlyOnceWith("ggs-7f3k2q")
  })

  it("does not commit an empty scan field", () => {
    const onScan = vi.fn()
    const field = document.createElement("input")
    document.body.append(field)
    stop = createWedgeListener({
      onScan,
      isScanField: (element) => element === field,
    })

    press(field, "Enter")

    expect(onScan).not.toHaveBeenCalled()
  })

  it("ignores keystrokes carrying a modifier, so Cmd+K still opens the palette", () => {
    const onScan = vi.fn()
    const time = clock()
    stop = createWedgeListener({ onScan, now: time.now })

    document.body.dispatchEvent(
      new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true })
    )
    type(document.body, "GS7F3K2Q", time)
    press(document.body, "Enter")

    expect(onScan).toHaveBeenCalledExactlyOnceWith("GS7F3K2Q")
  })

  it("stops listening once the returned teardown runs", () => {
    const onScan = vi.fn()
    const time = clock()
    const teardown = createWedgeListener({ onScan, now: time.now })
    teardown()

    type(document.body, "GGS7F3K2Q", time)
    press(document.body, "Enter")

    expect(onScan).not.toHaveBeenCalled()
  })
})
