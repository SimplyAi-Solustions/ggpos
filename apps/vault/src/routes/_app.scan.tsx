import { createFileRoute } from "@tanstack/react-router"

import { ScanPage } from "@/features/scan"

export const Route = createFileRoute("/_app/scan")({
  validateSearch: (search: Record<string, unknown>): { deal?: string } => ({
    deal: typeof search.deal === "string" && search.deal ? search.deal : undefined,
  }),
  component: Scan,
})

function Scan() {
  const { deal } = Route.useSearch()
  return <ScanPage dealId={deal} />
}
