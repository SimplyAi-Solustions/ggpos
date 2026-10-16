import * as React from "react"

/**
 * Opens the Set PIN sheet. The counter shell owns the sheet and provides this
 * on every screen, the till included, whose header sits inside the route
 * rather than the shell (app/account-menu.tsx).
 */
export const SetPinContext = React.createContext<() => void>(() => undefined)
