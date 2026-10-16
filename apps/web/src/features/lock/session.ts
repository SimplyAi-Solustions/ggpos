/**
 * Taking over the counter's session after a PIN unlock.
 *
 * `POST /api/vault/till/unlock` answers with the same body a password
 * sign-in does (`{ token, record }`, docs/api-contract-epos.md, section 2),
 * so it is stored exactly the same way: live, in the SDK's auth store, which
 * `lib/auth.ts` is already listening to. Nothing else about the counter
 * changes, so the till's ticket, the screen and its scroll all stay as they
 * were when somebody else unlocks it.
 *
 * Demo mode keeps its session beside the SDK's store, and the demo unlock
 * hands back a one-time grant in place of a token, which the ordinary demo
 * sign-in accepts once. Going through `login` puts the new person in the
 * demo session the same way a password sign-in would.
 */
import type { RecordModel } from "pocketbase"

import { pb } from "@/lib/pb"
import { isDemo } from "@/lib/api/mode"
import { currentStaff, login } from "@/lib/auth"
import type { StaffAuth } from "@/lib/api/staff"
import type { StaffRecord } from "@/lib/api/types"

export async function adoptSession(auth: StaffAuth): Promise<StaffRecord | null> {
  if (isDemo()) {
    return login(String(auth.record.email ?? ""), auth.token)
  }
  pb.authStore.save(auth.token, auth.record as unknown as RecordModel)
  return currentStaff()
}
