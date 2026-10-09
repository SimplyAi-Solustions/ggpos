/** The X and Z history, read by the cash-up screen and refreshed after each report. */
export const REPORTS_KEY = ["till-reports"] as const

/** One saved report, cached the moment it is run so showing it needs no second read. */
export const REPORT_KEY = ["till-report"] as const
