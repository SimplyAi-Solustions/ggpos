/**
 * The menu under the signed-in person's initials: their own settings, the
 * tutorials, then Lock and Sign out. The same menu on every counter screen,
 * the till included, so whoever is signed in can reach the tutorials, their
 * PIN and their password from wherever they are.
 *
 * "Set PIN" opens the shell's own sheet through `SetPinContext`.
 */
import * as React from "react"
import { useNavigate } from "@tanstack/react-router"
import { cn } from "cn"

import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Hint } from "@/components/ui/micro-label"
import {
  Menu,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuPrimitive,
  MenuSeparator,
  MenuTrigger,
} from "@/components/ui/menu"
import { useTheme } from "@/components/theme-provider"
import { initials, logout, useStaff } from "@/lib/auth"
import { isDemo, setSimulatedOffline } from "@/lib/api"
import { netSnapshot, subscribeNet } from "@/lib/offline/net"
import { lockCounter } from "@/features/lock/lock-store"
import { isManagerUp, useStaffRole } from "@/features/lock/role"
import { SetPinContext } from "@/app/set-pin-context"

export function AccountMenu({ className }: { className?: string }) {
  const staff = useStaff()
  const role = useStaffRole()
  const navigate = useNavigate()
  const onSetPin = React.useContext(SetPinContext)
  const { theme, setTheme } = useTheme()
  // Demo mode only: one switch so the offline queue can be walked, shown to
  // staff and tested without unplugging anything.
  const demo = isDemo()
  const net = React.useSyncExternalStore(subscribeNet, netSnapshot)

  return (
    <Menu>
      <MenuTrigger
        render={
          <button
            type="button"
            aria-label={staff ? `Account menu for ${staff.name}` : "Account menu"}
            className={cn("rounded-full outline-none", className)}
          />
        }
      >
        <Avatar>
          <AvatarFallback>{initials(staff?.name ?? "")}</AvatarFallback>
        </Avatar>
      </MenuTrigger>
      <MenuContent>
        {/* The signed-in name is a group label, and Base UI refuses one
            outside a group: without this the menu throws the moment it
            opens. */}
        <MenuPrimitive.Group>
          <MenuLabel>{staff?.name ?? "Signed in"}</MenuLabel>
          <MenuItem onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
            <span>Night mode</span>
            <Hint>{theme === "dark" ? "On" : "Off"}</Hint>
          </MenuItem>
          <MenuItem onClick={() => void navigate({ to: "/account" })}>My Vault</MenuItem>
          {/* Everybody's own: the password goes through
              POST /api/vault/staff/me/password, which works for every role,
              and the PIN is the one the lock screen takes. */}
          <MenuItem onClick={onSetPin}>Set PIN</MenuItem>
          <MenuItem onClick={() => void navigate({ to: "/counter/password" })}>
            Change password
          </MenuItem>
          {role === "admin" ? (
            <MenuItem onClick={() => void navigate({ to: "/counter/staff" })}>Staff</MenuItem>
          ) : null}
          {/* A manager registers tills, so a manager sees the Tills part of
              Settings; everything else there stays an admin's. */}
          {isManagerUp(role) ? (
            <MenuItem onClick={() => void navigate({ to: "/counter/settings" })}>
              Settings
            </MenuItem>
          ) : null}
          <MenuItem onClick={() => void navigate({ to: "/counter/tutorials" })}>Tutorials</MenuItem>
          {demo ? (
            <MenuItem onClick={() => setSimulatedOffline(!net.simulated)}>
              <span>Simulate offline</span>
              <Hint>{net.simulated ? "On" : "Off"}</Hint>
            </MenuItem>
          ) : null}
        </MenuPrimitive.Group>
        <MenuSeparator />
        <MenuItem onClick={() => lockCounter()}>Lock</MenuItem>
        <MenuItem
          onClick={() => {
            logout()
            void navigate({ to: "/login" })
          }}
        >
          Sign out
        </MenuItem>
      </MenuContent>
    </Menu>
  )
}
