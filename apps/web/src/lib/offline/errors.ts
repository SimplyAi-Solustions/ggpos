/**
 * The two things the counter says for itself when there is no line, kept in
 * a module with no dependencies so any part of the API layer can import
 * them without pulling the queue in behind them.
 */

/**
 * Something this app queued, or refused to queue, rather than sent. The
 * message is written for staff, so `refusalOrFallback` shows it as it
 * stands.
 */
export class OfflineQueuedError extends Error {}

/**
 * What a buy-in says when there is no connection.
 *
 * A buy-in writes the seller snapshot, the ID gate, the cash movement and
 * the items in one transaction on the server (docs/api-contract.md), so it
 * is never queued.
 */
export const OFFLINE_BUY_IN_MESSAGE =
  "Buy-ins need the server. Reconnect and try again."
