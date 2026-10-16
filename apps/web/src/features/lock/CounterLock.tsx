/**
 * The counter's lock, mounted once in each frame of the counter shell.
 *
 * Which lock is a question of the browser, not of the person: a registered
 * till (`useLockDevice()`) gets the PIN lock with the register's roster, on
 * the minutes `settings.epos.auto_lock_minutes` sets; any other browser
 * keeps the password lock after ten minutes, exactly as before the till.
 * Either way the flag is the one in `lock-store.ts`, so the till's Lock key
 * and the account menu lock both.
 */
import { EPOS_DEFAULTS, useCounterConfig } from "@/lib/api/config"
import { useStaff } from "@/lib/auth"
import { PasswordLock } from "@/app/idle-lock"
import { PASSWORD_LOCK_MINUTES, useAutoLock } from "@/features/lock/auto-lock"
import { useLockDevice } from "@/features/lock/device"
import { useCounterLocked } from "@/features/lock/lock-store"
import { LockScreen } from "@/features/lock/LockScreen"

export function CounterLock() {
  const staff = useStaff()
  const device = useLockDevice()
  const locked = useCounterLocked()
  const { data: config } = useCounterConfig()

  const minutes = device
    ? (config?.epos.auto_lock_minutes ?? EPOS_DEFAULTS.auto_lock_minutes)
    : PASSWORD_LOCK_MINUTES
  useAutoLock(staff && !locked ? minutes * 60_000 : 0)

  if (!staff || !locked) return null
  return device ? <LockScreen device={device} /> : <PasswordLock />
}
