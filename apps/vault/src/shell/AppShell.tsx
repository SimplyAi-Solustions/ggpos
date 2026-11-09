import * as React from "react"
import { Link, useRouterState } from "@tanstack/react-router"
import { AnimatePresence, motion } from "motion/react"

import { Wordmark } from "@/brand/Logo"
import { initials, useStaff } from "@/lib/auth"
import { Rail, TabBar } from "@/shell/TabBar"

/**
 * The signed-in frame: header with the GG lockup, the page, and the bottom
 * tab bar (phones) or left rail (tablet and up). Safe areas are respected on
 * every edge, so it sits right as an installed web app on an iPhone.
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  const staff = useStaff()
  const pathname = useRouterState({ select: (s) => s.location.pathname })

  return (
    <div className="min-h-dvh">
      <Rail />
      <header className="glass sticky top-0 z-30 border-b border-line pt-[var(--safe-top)] md:pl-[88px] lg:pl-[220px]">
        <div className="mx-auto flex h-14 max-w-5xl items-center justify-between pr-[max(16px,var(--safe-right))] pl-[max(16px,var(--safe-left))] md:px-6">
          <Link to="/scan" aria-label="GG Vault, go to Scan" className="rounded-sm">
            <Wordmark />
          </Link>
          {staff && (
            <Link
              to="/more"
              aria-label={`Signed in as ${staff.name || staff.email}. Open More.`}
              className="flex size-9 items-center justify-center rounded-full bg-pop font-mono text-xs font-bold text-on-pop dark:[box-shadow:var(--glow-pop)]"
            >
              {initials(staff.name || staff.email)}
            </Link>
          )}
        </div>
      </header>

      <main className="md:pl-[88px] lg:pl-[220px]">
        <div className="mx-auto max-w-5xl pt-5 pr-[max(16px,var(--safe-right))] pb-[calc(var(--tabbar-h)+var(--safe-bottom)+24px)] pl-[max(16px,var(--safe-left))] md:px-6 md:pb-10">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={pathname}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
          >
            {children}
          </motion.div>
        </AnimatePresence>
        </div>
      </main>

      <TabBar />
    </div>
  )
}
