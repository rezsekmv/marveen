// The result texts the message router writes when IT closes a local row as
// 'failed' because delivery went wrong -- as opposed to a refusal or a real
// outcome. The text is only half of the test: provenance is the failed_by =
// 'router' column, which only the router's closes set (a PUT caller can write
// any result text). See markRouterFailedMessageDone in db.ts. One definition, used by the writer (web/message-router.ts) and by
// the reader that lets such a row still take a later real 'done' (db.ts,
// markRouterFailedMessageDone). Deliberately dependency-free so db.ts can
// import it without pulling in the router.
//
// Why a router failure is not final (Q final review of cc-link, M1): the
// status guard made every terminal row immutable, but these three are the
// router's GUESS that nobody got the row, and the guess can be wrong:
//   - inject give-up: sendPromptToSession can throw although the text reached
//     the pane; the agent did the work and its PUT done must land;
//   - abandon: a row to a system sender id (a cc-link laptop) has no session,
//     so the router always abandons it, and the laptop claims it later by PUT;
//   - delivery error: the router threw somewhere in its own processing, which
//     says nothing about whether the recipient saw the row.
//
// NOT in the list, on purpose:
//   - 'Invalid or empty from_agent' (router and drain-inbox): a REFUSAL. The
//     from_agent could not be framed safely, so the row was withheld from the
//     agent by design; accepting a late done would launder it into a normal
//     closed conversation row.
//   - system-directive anchor failures: every agent authenticates a directive
//     by reading its row back and requiring that it is not 'failed'. Turning a
//     failed anchor into 'done' would make a directive that was never injected
//     verify as genuine.
//   - ROUTER_REFUSAL_PREFIX ('Refused: '): a deliberate refusal thrown inside
//     the delivery path (a path-traversal to_agent); poison by construction.
//   - the federation bridge's 'Abandoned: peer unreachable ...': a federated
//     row is answered by the peer as a NEW inbound message, never by a local
//     PUT, so there is no late close to accept.

export const ROUTER_ABANDON_REASON = 'Abandoned: target session absent for full retry window'
/** Followed by `<n> attempts`. */
export const ROUTER_INJECT_GIVEUP_PREFIX = 'Failed to inject into tmux session after '
/** Followed by the error text (truncated). */
export const ROUTER_DELIVERY_ERROR_PREFIX = 'Delivery error: '
/**
 * A deliberate refusal thrown inside the delivery path (today: safeJoin's
 * PathTraversalError on a '..'-bearing to_agent), caught by the same per-row
 * catch as a delivery error but closed WITHOUT router provenance and under
 * this prefix: the row is poison by construction, nobody could have received
 * it, so it is never reopenable. Followed by the error text (truncated).
 */
export const ROUTER_REFUSAL_PREFIX = 'Refused: '

/** Exact results and prefixes, in the form db.ts matches them (exact | prefix). */
export const ROUTER_RECOVERABLE_FAILURES: ReadonlyArray<{ text: string; match: 'exact' | 'prefix' }> = [
  { text: ROUTER_ABANDON_REASON, match: 'exact' },
  { text: ROUTER_INJECT_GIVEUP_PREFIX, match: 'prefix' },
  { text: ROUTER_DELIVERY_ERROR_PREFIX, match: 'prefix' },
]

export function isRouterRecoverableFailure(result: string | null | undefined): boolean {
  if (!result) return false
  return ROUTER_RECOVERABLE_FAILURES.some(f => (f.match === 'exact' ? result === f.text : result.startsWith(f.text)))
}
