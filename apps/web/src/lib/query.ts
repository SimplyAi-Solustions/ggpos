import { QueryClient } from "@tanstack/react-query"

/**
 * One query client for the app. A counter screen refreshes when the data
 * changes (Phase 2 subscribes to PocketBase realtime), not when the window
 * regains focus, so a till that sits open all day does not refetch on every
 * alt-tab.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
})
