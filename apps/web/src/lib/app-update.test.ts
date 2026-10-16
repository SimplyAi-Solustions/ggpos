import { afterEach, describe, expect, it, vi } from "vitest"
import { renderHook, act } from "@testing-library/react"

import {
  resetAppUpdateForTests,
  useAppUpdateReady,
  watchForAppUpdate,
  type ServiceWorkerContainerLike,
} from "./app-update"

function fakeWorker(controller: unknown) {
  const changes: (() => void)[] = []
  const update = vi.fn(async () => undefined)
  const sw: ServiceWorkerContainerLike = {
    controller,
    addEventListener: (_type, listener) => changes.push(listener),
    getRegistration: async () => ({ update }),
  }
  const takeOver = (next: unknown) => {
    sw.controller = next
    for (const listener of changes) listener()
  }
  return { sw, update, takeOver }
}

function fakeDocument() {
  const listeners: (() => void)[] = []
  const doc = {
    visibilityState: "hidden" as DocumentVisibilityState,
    addEventListener: (_type: string, listener: () => void) => listeners.push(listener),
  }
  const show = () => {
    doc.visibilityState = "visible"
    for (const listener of listeners) listener()
  }
  return { doc: doc as unknown as Document, show }
}

afterEach(() => resetAppUpdateForTests())

describe("a new build reaching an open tab", () => {
  it("says so when a new worker takes over from an old one", () => {
    const worker = fakeWorker({ id: "old" })
    watchForAppUpdate({ sw: worker.sw, doc: undefined, every: () => undefined })
    const { result } = renderHook(() => useAppUpdateReady())
    expect(result.current).toBe(false)
    act(() => worker.takeOver({ id: "new" }))
    expect(result.current).toBe(true)
  })

  it("says nothing on the first install, then speaks up for the next build", () => {
    const worker = fakeWorker(null)
    watchForAppUpdate({ sw: worker.sw, doc: undefined, every: () => undefined })
    const { result } = renderHook(() => useAppUpdateReady())
    act(() => worker.takeOver({ id: "first" }))
    expect(result.current).toBe(false)
    act(() => worker.takeOver({ id: "second" }))
    expect(result.current).toBe(true)
  })

  it("asks for an update on a timer and when the tab comes back into view", async () => {
    const worker = fakeWorker({ id: "old" })
    const page = fakeDocument()
    let tick: (() => void) | undefined
    watchForAppUpdate({ sw: worker.sw, doc: page.doc, every: (fn) => (tick = fn) })

    tick?.()
    await vi.waitFor(() => expect(worker.update).toHaveBeenCalledTimes(1))
    page.show()
    await vi.waitFor(() => expect(worker.update).toHaveBeenCalledTimes(2))
  })

  it("does nothing where there is no service worker, and watches once", () => {
    expect(() => watchForAppUpdate({ sw: undefined, doc: undefined, every: () => undefined })).not.toThrow()
    const worker = fakeWorker({ id: "old" })
    const every = vi.fn()
    watchForAppUpdate({ sw: worker.sw, doc: undefined, every })
    watchForAppUpdate({ sw: worker.sw, doc: undefined, every })
    expect(every).toHaveBeenCalledTimes(1)
  })
})
