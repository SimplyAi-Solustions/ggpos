import * as React from "react"

import { Button } from "@/components/ui/button"
import { Lede, PageTitle } from "@/components/ui/page-title"
import { pingPocketBase } from "@/lib/pb"

/**
 * The counter shell and the sign-in screen both show this, and only this,
 * when a production build cannot reach PocketBase at boot: no nav, no demo
 * fallback, nothing that would let staff believe stock is being kept when it
 * is not. "Try again" re-pings and, once the server answers, reloads so the
 * whole app boots fresh against it rather than swapping data sources under
 * whatever is on screen.
 */
export function ServerUnreachable() {
  const [checking, setChecking] = React.useState(false)

  async function tryAgain() {
    setChecking(true)
    const alive = await pingPocketBase()
    if (alive) {
      window.location.reload()
      return
    }
    setChecking(false)
  }

  return (
    <div className="flex min-h-svh w-full flex-col bg-background">
      <main className="mx-auto w-full max-w-[1040px] flex-1 px-5 pt-16 sm:px-10 sm:pt-24">
        <PageTitle>Server not reachable</PageTitle>
        <Lede>The counter cannot reach GG Vault. Check the connection, then try again.</Lede>
        <div className="mt-14">
          <Button type="button" onClick={() => void tryAgain()} loading={checking}>
            Try again
          </Button>
        </div>
      </main>
    </div>
  )
}
