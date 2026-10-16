import * as React from "react"

import { Lede, PageTitle } from "@/components/ui/page-title"

/**
 * A screen that is planned but not built yet. It says what will be here in
 * the house voice, in one sentence, and never in lorem ipsum: a half-built
 * counter still has to read as GG Vault.
 */
export function Placeholder({
  title,
  lede,
  children,
}: {
  title: string
  lede: string
  children?: React.ReactNode
}) {
  return (
    <section className="pt-16 sm:pt-24">
      <PageTitle>{title}</PageTitle>
      <Lede>{lede}</Lede>
      {children}
    </section>
  )
}
