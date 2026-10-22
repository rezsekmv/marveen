// The server-side fence around a 'messages' scoped device key (cc-link).
//
// A messages key is what a laptop link (tools/cc-link-mcp) carries: it posts
// rows as ONE system sender and reads that sender's mailbox. Before this scope
// existed the link needed a full key, so a lost laptop meant a lost key to
// memories, kanban, the vault and agent control. Mirrors operator-gate.ts:
// decided BEFORE any route handler runs, deny-by-default, so a route added
// later is closed to the key without anyone remembering to close it. Every
// other credential (token, session, full/operator device key, federation) is
// untouched by this gate.
//
// Split of the checks, by who holds the data:
//   - here (path, method, query): which endpoints at all, and that the mailbox
//     list is asked for the key's own sender;
//   - routes/messages.ts (body, row): POST from === the bound sender, and that
//     a single row read or closed has the sender on one end. The gate cannot
//     see either without reading the body or the DB.

import { sanitizeAgentIdent } from '../prompt-safety.js'
import { isKnownAgent } from './agent-config.js'
import { COORDINATOR_AGENT_ID, VOICE_CHANNEL_AGENT_ID } from '../channel-coordinator/ingest.js'
import { SYSTEM_DIRECTIVE_SENDER } from './system-directive.js'
import { MAIN_AGENT_ID, HEARTBEAT_AGENT_ID, OWNER_NAME } from '../config.js'
import { CHAT_SYSTEM_AGENTS } from '../db.js'

export const WHOAMI_PATH = '/api/auth/whoami'

export interface MessagesGateAuth {
  kind: string
  scope?: string
  senderId?: string
}

const MESSAGE_ROW_RE = /^\/api\/messages\/\d+$/

/** null = let it through; otherwise the reason for a 403 (same shape as the operator gate). */
export function messagesGateDecision(auth: MessagesGateAuth, path: string, method: string, url: URL): string | null {
  if (auth.kind !== 'device' || auth.scope !== 'messages') return null
  // A messages row with no sender (hand-edited DB) acts as nobody: fail closed.
  if (!auth.senderId) return 'messages credential: no bound sender'
  // Re-checked on EVERY request, not only at mint: an agent onboarded after the
  // key was minted under the same id would otherwise be impersonable by it.
  if (!messagesKeySender(auth)) return 'messages credential: its bound sender is now a reserved id'
  if (path === WHOAMI_PATH && method === 'GET') return null
  if (path === '/api/messages' && method === 'POST') return null
  if (path === '/api/messages' && method === 'GET') {
    // The list handler reads `agent` with get(), i.e. the FIRST value; a second
    // agent= could only exist to make the gate and the handler read different
    // values, so exactly one is required. Without agent= the handler returns the
    // fleet's last N rows (or every pending row), which is everyone's traffic.
    const agents = url.searchParams.getAll('agent')
    if (agents.length !== 1 || agents[0] !== auth.senderId) return 'messages credential: only its own mailbox (agent=<bound sender>)'
    return null
  }
  if (MESSAGE_ROW_RE.test(path) && (method === 'GET' || method === 'PUT')) return null
  return 'messages credential: not a message endpoint'
}

/**
 * The sender a messages-scoped principal may act as RIGHT NOW, or null when it
 * may act as nobody (no bound sender, or the bound id has since become
 * reserved; the voice relay binding is not reserved for this purpose, see
 * isVoiceRelayBinding). The one place every messages-key use asks: the gate (POST, the
 * agent= list, the row routes, whoami), the row-ownership check and the POST
 * from check -- so a later-reserved id is cut off everywhere at once.
 */
export function messagesKeySender(auth: MessagesGateAuth | undefined): string | null {
  if (auth?.kind !== 'device' || auth.scope !== 'messages' || !auth.senderId) return null
  return isReservedSenderId(auth.senderId) && !isVoiceRelayBinding(auth.senderId) ? null : auth.senderId
}

/** Row ownership for GET/PUT /api/messages/<id>: the bound sender must be on one end. */
export function messagesKeyOwnsRow(auth: MessagesGateAuth | undefined, row: { from_agent: string; to_agent: string }): boolean {
  if (auth?.kind !== 'device' || auth.scope !== 'messages') return true
  const sender = messagesKeySender(auth)
  if (!sender) return false
  return row.from_agent === sender || row.to_agent === sender
}

/**
 * Is this id one a messages key may never act as? Reserved, compared
 * case-insensitively (a near-miss of a privileged id buys nothing legitimate
 * and costs a review), is every id that means something to the router or to
 * an agent reading from_agent -- derived from the SAME constants the POST
 * /api/messages guards and the router use, not a hand copy:
 *   - SYSTEM_DIRECTIVE_SENDER: authenticates stop/restart directives;
 *   - COORDINATOR_AGENT_ID, VOICE_CHANNEL_AGENT_ID: earn channel-inbound
 *     (owner, reply-expected) framing in the router;
 *   - CHAT_SYSTEM_AGENTS: the in-process system senders (heartbeat, both
 *     coordinator ids incl. the legacy 'channel-coordinator', system);
 *   - MAIN_AGENT_ID, HEARTBEAT_AGENT_ID, OWNER_NAME (the POST owner exemption);
 *   - every registered fleet agent (isKnownAgent), read live, so an agent
 *     onboarded later under the key's id is protected from that moment on.
 */
export function isReservedSenderId(id: string): boolean {
  const lc = id.toLowerCase()
  const reserved = [SYSTEM_DIRECTIVE_SENDER, COORDINATOR_AGENT_ID, VOICE_CHANNEL_AGENT_ID, ...CHAT_SYSTEM_AGENTS, MAIN_AGENT_ID, HEARTBEAT_AGENT_ID, OWNER_NAME]
    .map(r => sanitizeAgentIdent(r).toLowerCase())
    .filter(Boolean)
  return reserved.includes(lc) || isKnownAgent(id) || isKnownAgent(lc)
}

/**
 * VOICEPROV1022: the ONE reserved id a messages key may still be bound to --
 * the voice channel (VOICE_CHANNEL_AGENT_ID). Its legitimate writer is an
 * out-of-process relay (hang-front), and a messages key is exactly the
 * credential that relay should hold: it can post as that one sender and read
 * that one mailbox, nothing else. Before this, the relay needed a FULL device
 * key, and POST /api/messages accepted from=<voice id> from ANY full key -- so
 * the row proved "some enrolled device", not "the voice relay". The
 * provenance gate (scripts/hooks/provenance-gate.py) now reads the voice row
 * back as proof of origin, which is only sound when the row can come from the
 * relay's own key alone (routes/messages.ts enforces the other half).
 *
 * The id stays RESERVED everywhere else (isReservedSenderId is unchanged): this
 * is a narrow carve-out for a messages-key binding only, and it is:
 *   - EXACT, no case folding: 'Hanna' sanitizes to an id the router does not
 *     resolve to the voice channel, and buys nothing legitimate;
 *   - void when a real fleet agent exists under that name (isKnownAgent): the
 *     key would then impersonate that agent;
 *   - void when the voice id coincides with another reserved identity (the
 *     main agent, the owner, a system sender): those keep their protection.
 */
export function isVoiceRelayBinding(id: string): boolean {
  if (id !== VOICE_CHANNEL_AGENT_ID) return false
  if (isKnownAgent(id)) return false
  const others = [SYSTEM_DIRECTIVE_SENDER, COORDINATOR_AGENT_ID, ...CHAT_SYSTEM_AGENTS, MAIN_AGENT_ID, HEARTBEAT_AGENT_ID, OWNER_NAME]
    .map(r => sanitizeAgentIdent(r).toLowerCase())
    .filter(Boolean)
  return !others.includes(id.toLowerCase())
}

export const SENDER_ID_MAX = 64

/**
 * Validate a sender id for a messages key at mint time. Returns the error text,
 * or null when the id is acceptable.
 *
 * Exact, not normalized: the stored id is compared byte-for-byte with POST
 * `from` and the list `agent=`, while the router matches sanitizeAgentIdent(from).
 * An id that sanitizes to something else would be one name at the gate and
 * another at delivery, so only ids that are already in sanitized form are taken.
 *
 * Reserved ids (isReservedSenderId) are refused here AND on every later use
 * (messagesKeySender): a key bound to one would turn a laptop credential into
 * that identity. The one exception is the voice relay's binding
 * (isVoiceRelayBinding, VOICEPROV1022), checked the same way in both places.
 */
export function validateMessagesSenderId(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return 'sender_id is required for a messages key'
  const id = raw.trim()
  if (id.length > SENDER_ID_MAX) return `sender_id is at most ${SENDER_ID_MAX} characters`
  if (sanitizeAgentIdent(id) !== id) return 'sender_id may contain only letters, digits, _ and -'
  if (isReservedSenderId(id) && !isVoiceRelayBinding(id)) return `sender_id '${id}' is reserved (a fleet agent or a system identity)`
  return null
}
