import { afterEach, describe, expect, it, vi } from "vitest"

import { changeOwnPassword } from "@/lib/api"
import { setDataMode } from "@/lib/api/mode"
import { pb } from "@/lib/pb"

/**
 * The one thing that is easy to get wrong about a password change: when
 * the auth store moves.
 *
 * The PATCH rotates the account's token key, so the token it was made
 * with is dead the moment it succeeds. If the store were re-saved at that
 * point (which is what the SDK's own `RecordService.update` does) the
 * counter's gate would see an unlocked staff member on a dead token and
 * swap the whole counter in around a half-finished form. So the store has
 * to change exactly once, at the re-authentication, and with the new
 * token.
 */

/**
 * A token the SDK will call valid: `isValid` only checks that the payload
 * decodes to a non-empty object with no `exp` in the past, never a real
 * signature, so any base64url-encoded JSON does.
 */
function fakeToken(payload: Record<string, unknown>): string {
  const segment = (value: unknown) =>
    btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
  return `${segment({ alg: "none", typ: "JWT" })}.${segment(payload)}.signature`
}

const EMAIL = "first-admin@ggentertainment.co.uk"
const OLD_TOKEN = fakeToken({ id: "staff_1", v: "before" })
const NEW_TOKEN = fakeToken({ id: "staff_1", v: "after" })

const LOCKED = {
  id: "staff_1",
  collectionId: "staff",
  collectionName: "staff",
  email: EMAIL,
  name: "First Admin",
  role: "admin",
  active: true,
  must_change_password: true,
}
const UNLOCKED = { ...LOCKED, must_change_password: false }

afterEach(() => {
  pb.authStore.clear()
})

describe("changeOwnPassword", () => {
  it("moves the auth store once, at the re-auth, and never on the dead token", async () => {
    setDataMode(false)
    pb.authStore.save(OLD_TOKEN, LOCKED)

    const tokensSeen: string[] = []
    const stop = pb.authStore.onChange((token) => tokensSeen.push(token))

    // What the PATCH is sent as, and what the store held while it ran.
    let tokenDuringUpdate = ""
    const send = vi.spyOn(pb, "send").mockImplementation(async () => {
      tokenDuringUpdate = pb.authStore.token
      return {}
    })
    const update = vi.spyOn(pb.collection("staff"), "update")
    const authWithPassword = vi
      .spyOn(pb.collection("staff"), "authWithPassword")
      .mockImplementation((async () => {
        pb.authStore.save(NEW_TOKEN, UNLOCKED)
        return { token: NEW_TOKEN, record: UNLOCKED }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any)

    const record = await changeOwnPassword(EMAIL, "the-temporary-one", "a-brand-new-password")
    stop()

    expect(tokensSeen).toEqual([NEW_TOKEN])
    expect(tokenDuringUpdate).toBe(OLD_TOKEN)
    expect(record.must_change_password).toBe(false)

    // The update is a plain send, not the SDK's record update: that one
    // re-saves the auth store with the dead token as a side effect.
    expect(update).not.toHaveBeenCalled()
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0]![0]).toBe("/api/collections/staff/records/staff_1")
    expect(send.mock.calls[0]![1]).toMatchObject({
      method: "PATCH",
      body: {
        oldPassword: "the-temporary-one",
        password: "a-brand-new-password",
        passwordConfirm: "a-brand-new-password",
      },
    })
    expect(authWithPassword).toHaveBeenCalledWith(EMAIL, "a-brand-new-password")
  })

  it("leaves the store where it was when the change itself is refused", async () => {
    setDataMode(false)
    pb.authStore.save(OLD_TOKEN, LOCKED)

    const tokensSeen: string[] = []
    const stop = pb.authStore.onChange((token) => tokensSeen.push(token))

    vi.spyOn(pb, "send").mockRejectedValue(new Error("refused"))
    const authWithPassword = vi.spyOn(pb.collection("staff"), "authWithPassword")

    await expect(
      changeOwnPassword(EMAIL, "the-wrong-one", "a-brand-new-password")
    ).rejects.toThrow()
    stop()

    expect(tokensSeen).toEqual([])
    expect(authWithPassword).not.toHaveBeenCalled()
    expect(pb.authStore.token).toBe(OLD_TOKEN)
  })
})
