import { describe, expect, it } from "vitest"

import { subscriptionKeys, urlBase64ToUint8Array } from "@/lib/push"

describe("urlBase64ToUint8Array", () => {
  it("decodes a base64url string into its bytes", () => {
    // "hello" is "aGVsbG8" in base64url with the padding dropped.
    expect(Array.from(urlBase64ToUint8Array("aGVsbG8"))).toEqual([
      104, 101, 108, 108, 111,
    ])
  })

  it("reads the url alphabet, not plain base64", () => {
    // 0xfb 0xff decodes from "-_8" in base64url; plain base64 would be "+/8".
    expect(Array.from(urlBase64ToUint8Array("-_8"))).toEqual([251, 255])
  })

  it("puts the padding back before decoding", () => {
    expect(urlBase64ToUint8Array("aGk").length).toBe(2)
    expect(urlBase64ToUint8Array("aGk=").length).toBe(2)
  })

  it("answers an empty array for an empty key", () => {
    expect(urlBase64ToUint8Array("").length).toBe(0)
  })
})

describe("subscriptionKeys", () => {
  it("takes the browser's own base64url encoding", () => {
    const subscription = {
      toJSON: () => ({ keys: { p256dh: "BLc-_8", auth: "c2VjcmV0" } }),
    } as unknown as PushSubscription
    expect(subscriptionKeys(subscription)).toEqual({
      p256dh: "BLc-_8",
      auth: "c2VjcmV0",
    })
  })

  it("answers empty strings rather than throwing on a subscription with no keys", () => {
    const subscription = { toJSON: () => ({}) } as unknown as PushSubscription
    expect(subscriptionKeys(subscription)).toEqual({ p256dh: "", auth: "" })
  })
})
