/**
 * The result texts the dashboard's message router writes when IT closes a row
 * as 'failed' because delivery went wrong (as opposed to a refusal or a real
 * outcome). Such a row, with failed_by = 'router', can still take a later
 * 'done' on the server.
 *
 * MIRRORS src/router-failure-reasons.ts in the server tree. It is a copy on
 * purpose: the laptop may run cc-link from a checkout or copy without the
 * server sources. test/router-reasons.test.ts compares the two whenever the
 * server file is present.
 */

export const ROUTER_ABANDON_REASON = 'Abandoned: target session absent for full retry window'
/** Followed by `<n> attempts`. */
export const ROUTER_INJECT_GIVEUP_PREFIX = 'Failed to inject into tmux session after '
/** Followed by the error text (truncated). */
export const ROUTER_DELIVERY_ERROR_PREFIX = 'Delivery error: '

/** Exact results and prefixes, in the form the server matches them. */
export const ROUTER_RECOVERABLE_FAILURES: ReadonlyArray<{ text: string; match: 'exact' | 'prefix' }> = [
  { text: ROUTER_ABANDON_REASON, match: 'exact' },
  { text: ROUTER_INJECT_GIVEUP_PREFIX, match: 'prefix' },
  { text: ROUTER_DELIVERY_ERROR_PREFIX, match: 'prefix' },
]

export function isRouterRecoverableFailure(result: string | null | undefined): boolean {
  if (!result) return false
  return ROUTER_RECOVERABLE_FAILURES.some(f => (f.match === 'exact' ? result === f.text : result.startsWith(f.text)))
}
