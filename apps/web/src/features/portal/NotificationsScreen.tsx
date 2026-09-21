import * as React from "react"
import { useNavigate } from "@tanstack/react-router"
import { useQuery, useQueryClient } from "@tanstack/react-query"

import { MicroLabel } from "@/components/ui/micro-label"
import { Lede, PageTitle } from "@/components/ui/page-title"
import { SkeletonText } from "@/components/ui/skeleton"
import { StickerRing } from "@/components/ui/sticker"
import { listMyNotifications, markNotificationRead } from "@/lib/api/notifications"
import { formatDateTime } from "@/features/portal/format"
import { LoadFailed } from "@/features/portal/LoadFailed"
import { Note } from "@/features/portal/Note"
import { portalLinkFrom } from "@/features/portal/notification-link"

/**
 * What the shop has told this customer.
 *
 * Opening the list marks everything on it read, because that is what reading
 * it means; the unread marker is a word, "New", rather than a coloured dot,
 * so it survives night mode and a reader who cannot tell the colours apart.
 */
export function NotificationsScreen() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: ["portal", "notifications"],
    queryFn: listMyNotifications,
  })

  // One pass, the first time a page arrives. The ids are taken from that
  // page, so a row that lands while the marking is in flight stays unread.
  const marked = React.useRef(false)
  React.useEffect(() => {
    if (!data || marked.current) return
    const unread = data.items.filter((row) => !row.read_at).map((row) => row.id)
    if (unread.length === 0) return
    marked.current = true
    void (async () => {
      try {
        for (const id of unread) await markNotificationRead(id)
        await queryClient.invalidateQueries({ queryKey: ["portal", "notifications"] })
      } catch {
        // Marking read is a convenience, not the point of the screen: a
        // failure leaves the rows unread and the badge honest, and the next
        // visit tries again rather than showing an error over the list.
        marked.current = false
      }
    })()
  }, [data, queryClient])

  if (isError) {
    return (
      <LoadFailed
        title="Notifications"
        error={error}
        fallback="We could not read your notifications just now. Check your connection and try again."
        onRetry={() => void refetch()}
      />
    )
  }

  const rows = data?.items ?? []

  return (
    <section className="pt-12 sm:pt-20">
      <PageTitle>Notifications</PageTitle>
      <Lede>Offers, holds and anything else we need to tell you.</Lede>

      {isPending ? (
        <div className="mt-12">
          <SkeletonText lines={4} />
        </div>
      ) : rows.length === 0 ? (
        <div className="mt-14 flex items-start gap-5">
          <StickerRing className="size-14" />
          <p className="max-w-[48ch] text-base leading-[1.5] text-muted-foreground">
            Nothing to tell you yet. We will let you know when a quote is
            priced or a card on your want list comes in.
          </p>
        </div>
      ) : (
        <ul className="mt-12 flex flex-col">
          {rows.map((row) => {
            const body = (
              <span className="flex min-w-0 flex-col gap-1.5 py-4">
                <span className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="text-base leading-[1.35] text-foreground">
                    {row.title}
                  </span>
                  {!row.read_at ? <MicroLabel tone="ink">New</MicroLabel> : null}
                </span>
                <span className="max-w-[52ch] text-[15px] leading-[1.5] text-muted-foreground">
                  {row.body}
                </span>
                <Note>{formatDateTime(row.created)}</Note>
              </span>
            )
            // Only an in-app path is ever followed, and the router takes the
            // ordinary click so the app never reloads to move one screen.
            const link = portalLinkFrom(row.link)
            return (
              <li key={row.id} className="border-b border-hairline-soft">
                {link ? (
                  <a
                    href={link}
                    className="flex min-h-16 transition-colors duration-150 ease-gg hover:bg-row-hover"
                    onClick={(event) => {
                      if (event.metaKey || event.ctrlKey || event.shiftKey) return
                      event.preventDefault()
                      void navigate({ to: link })
                    }}
                  >
                    {body}
                  </a>
                ) : (
                  <span className="flex min-h-16">{body}</span>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
