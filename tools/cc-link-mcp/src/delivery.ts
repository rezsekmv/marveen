/**
 * Pure delivery rules (no I/O). See README "Delivery rules":
 *  (1) an answer goes only to the asking session        -> ownAsks
 *  (2) a new session adopts asks of dead sessions        -> orphanAsks
 *  (3) main-agent-initiated messages are claimed only by
 *      a NEW session in the folder named by an explicit
 *      folder:<key> marker; unaddressed ones are never
 *      claimed, only listed                               -> selectInbox / selectUnaddressed
 */
import { createHash } from 'node:crypto'
import type { MessageRow } from './api.ts'
import { isRouterRecoverableFailure, ROUTER_ABANDON_REASON } from './router-reasons.ts'

export interface AskRecord {
  id: number
  pid: number
  /** ISO timestamp. */
  createdAt: string
  preview: string
  /**
   * ISO time the CURRENT pid took ownership (set on adoption). The boot rule
   * below reads this instead of createdAt, so an ask adopted after a reboot is
   * not judged dead just because it was created before the reboot.
   */
  ownedSince?: string
}

/**
 * Addressing is EXPLICIT: only a `folder:<8 hex>` marker addresses a folder
 * (case-insensitive). The marker must not be glued to a preceding word
 * character and the key must not continue with another alphanumeric, so
 * "reply 20261018", a bare "ae2a5fc3" or "subfolder:ae2a5fc3" address nothing.
 */
const FOLDER_MARKER_RE = /(?<![A-Za-z0-9_])folder:([0-9a-f]{8})(?![0-9A-Za-z])/gi

/** Every folder key a note addresses (lowercase). */
export function folderKeysIn(note: string | null | undefined): string[] {
  if (!note) return []
  return [...note.matchAll(FOLDER_MARKER_RE)].map(m => m[1]!.toLowerCase())
}

/** True when `note` carries `folder:<key>` (case-insensitive). */
export function hasFolderKeyToken(note: string | null | undefined, key: string): boolean {
  const k = key.toLowerCase()
  return folderKeysIn(note).includes(k)
}

/** True when `note` addresses SOME folder (has at least one `folder:<key>` marker). */
export function hasAnyFolderKeyToken(note: string | null | undefined): boolean {
  return folderKeysIn(note).length > 0
}

/**
 * A row the dashboard's ROUTER closed as failed for a recoverable reason
 * (abandoned, inject give-up, delivery error). Such a row is still
 * deliverable: the dashboard accepts a later 'done' on it.
 *
 * - `failed_by` present (current dashboards): claimable only when it is
 *   'router' AND the result is one of the router reasons. A row failed without
 *   router provenance (null: a PUT failed, or failed before the column
 *   existed) is not claimable; the dashboard would answer 409.
 * - `failed_by` absent (an older dashboard that does not return it): the
 *   previous rule, the router reasons or any result starting with
 *   "Abandoned". A 409 from such a server is remembered per row id
 *   (skipped.json), so it is not retried on every startup.
 */
export function isRouterFailedClaimable(row: Pick<MessageRow, 'status' | 'result' | 'failed_by'>): boolean {
  if (row.status !== 'failed' || typeof row.result !== 'string') return false
  if (row.failed_by !== undefined) return row.failed_by === 'router' && isRouterRecoverableFailure(row.result)
  return isRouterRecoverableFailure(row.result) || row.result.startsWith('Abandoned')
}

/** A router-failed row with router provenance: the dashboard may still close it 'done' later. */
export function isReopenableRouterFailure(row: Pick<MessageRow, 'status' | 'result' | 'failed_by'>): boolean {
  return row.status === 'failed' && row.failed_by === 'router' && isRouterRecoverableFailure(row.result)
}

export interface InboxContext {
  senderId: string
  mainAgentId: string
  folderKey: string
}

/** A row from the main agent to this machine that has not been claimed yet. */
export function isInboxCandidate(row: MessageRow, ctx: Pick<InboxContext, 'senderId' | 'mainAgentId'>): boolean {
  return (
    row.to_agent === ctx.senderId &&
    row.from_agent === ctx.mainAgentId &&
    (row.status === 'pending' || isRouterFailedClaimable(row))
  )
}

/** Addressed to this folder by an explicit `folder:<key>` marker. */
export function isForFolder(row: MessageRow, folderKey: string): boolean {
  return hasFolderKeyToken(row.origin_note, folderKey)
}

function compareRows(a: MessageRow, b: MessageRow): number {
  const ca = typeof a.created_at === 'number' ? a.created_at : 0
  const cb = typeof b.created_at === 'number' ? b.created_at : 0
  return ca !== cb ? ca - cb : a.id - b.id
}

function dedupeSorted(rows: Iterable<MessageRow>): MessageRow[] {
  const byId = new Map<number, MessageRow>()
  for (const r of rows) if (!byId.has(r.id)) byId.set(r.id, r)
  return [...byId.values()].sort(compareRows)
}

/**
 * Folder-inbox selection: candidates addressed to THIS folder, deduplicated
 * by id, oldest first. Unaddressed rows are never selected (they are only
 * listed, see selectUnaddressed). Input may mix several API listings.
 */
export function selectInbox(rows: readonly MessageRow[], ctx: InboxContext): MessageRow[] {
  return dedupeSorted(rows.filter(r => isInboxCandidate(r, ctx) && isForFolder(r, ctx.folderKey)))
}

/** Candidates with no folder marker at all: never claimed, only listed by tony_inbox. */
export function selectUnaddressed(rows: readonly MessageRow[], ctx: Pick<InboxContext, 'senderId' | 'mainAgentId'>): MessageRow[] {
  return dedupeSorted(rows.filter(r => isInboxCandidate(r, ctx) && !hasAnyFolderKeyToken(r.origin_note)))
}

/** Asks this session watches (rule 1). */
export function ownAsks(asks: readonly AskRecord[], pid: number): AskRecord[] {
  return asks.filter(a => a.pid === pid)
}

/**
 * Is the session that owns `ask` gone? An owner recorded before the last boot
 * is gone whatever its pid says: after a reboot the pid may belong to an
 * unrelated process (pid reuse), which would keep the ask unadopted forever.
 */
export function isOwnerGone(ask: AskRecord, isAlive: (pid: number) => boolean, bootMs?: number): boolean {
  if (bootMs !== undefined) {
    const since = Date.parse(ask.ownedSince ?? ask.createdAt)
    if (Number.isFinite(since) && since < bootMs) return true
  }
  return !isAlive(ask.pid)
}

/** Asks whose owning session is gone (rule 2). Never includes `selfPid`. */
export function orphanAsks(
  asks: readonly AskRecord[],
  isAlive: (pid: number) => boolean,
  selfPid?: number,
  bootMs?: number,
): AskRecord[] {
  return asks.filter(a => a.pid !== selfPid && isOwnerGone(a, isAlive, bootMs))
}

/** Rewrite the pid of every orphan to `newPid` (stamping ownedSince); returns the new list and the adopted ids. */
export function adoptOrphans(
  asks: readonly AskRecord[],
  newPid: number,
  isAlive: (pid: number) => boolean,
  bootMs?: number,
  nowIso: string = new Date().toISOString(),
): { asks: AskRecord[]; adopted: number[] } {
  const orphanIds = new Set(orphanAsks(asks, isAlive, newPid, bootMs).map(a => a.id))
  return {
    asks: asks.map(a => (orphanIds.has(a.id) ? { ...a, pid: newPid, ownedSince: nowIso } : a)),
    adopted: [...orphanIds],
  }
}

export type AskOutcome =
  | { state: 'answered'; result: string }
  | { state: 'failed'; result: string }
  | { state: 'closed'; result: string }
  | { state: 'waiting' }

export const CLOSED_WITHOUT_ANSWER = '(closed without an answer)'
export const ABANDONED_ASK_TEXT = 'not delivered to the main agent (abandoned by the router)'

/**
 * How an ask row stands. `done` with an empty result is 'closed' (settled,
 * nothing to show but that). A reopenable router failure is still 'waiting'.
 */
export function classifyAskRow(row: Pick<MessageRow, 'status' | 'result' | 'failed_by'>): AskOutcome {
  const result = typeof row.result === 'string' ? row.result : ''
  if (row.status === 'done') {
    return result.trim().length > 0 ? { state: 'answered', result } : { state: 'closed', result: CLOSED_WITHOUT_ANSWER }
  }
  // ABANDON is final for an ask: the router gave up because the main agent's
  // session was never there, so nobody saw the question. Report it at once
  // instead of watching it for 7 days.
  if (row.status === 'failed' && result === ROUTER_ABANDON_REASON) {
    return { state: 'failed', result: `${ABANDONED_ASK_TEXT}: ${result}` }
  }
  // Inject give-up and delivery error (router provenance) are not final: the
  // text may have reached the main agent, which can still close the row 'done'
  // with the answer. Keep waiting (7-day expiry applies).
  if (isReopenableRouterFailure(row)) return { state: 'waiting' }
  if (row.status === 'failed') return { state: 'failed', result: result || '(no reason given)' }
  return { state: 'waiting' }
}

/** An unanswered ask older than `maxAgeMs` (default 7 days) is settled with an expiry notice. */
export function isAskExpired(ask: Pick<AskRecord, 'createdAt'>, nowMs: number, maxAgeMs = 7 * 24 * 60 * 60 * 1000): boolean {
  const t = Date.parse(ask.createdAt)
  return Number.isFinite(t) && nowMs - t > maxAgeMs
}

/** One-line preview of a question for asks.json / tony_inbox. */
export function makePreview(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : flat.slice(0, max - 1) + '…'
}

// ------------------------------------------------------------- 409 skip memory

/**
 * One remembered 409 on a claim. A row is skipped only when EVERY field
 * matches, so a different dashboard (baseUrl) or a new row that reuses an old
 * id after a database reset (different created_at / sender / content) is
 * claimed normally.
 */
export interface SkipEntry {
  baseUrl: string
  id: number
  created_at: number
  from_agent: string
  /** First 16 hex chars of sha256(content). */
  contentHash: string
}

export function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16)
}

export function skipEntryFor(row: Pick<MessageRow, 'id' | 'created_at' | 'from_agent' | 'content'>, baseUrl: string): SkipEntry {
  return {
    baseUrl,
    id: row.id,
    created_at: row.created_at,
    from_agent: row.from_agent,
    contentHash: contentHash(typeof row.content === 'string' ? row.content : ''),
  }
}

function sameSkip(a: SkipEntry, b: SkipEntry): boolean {
  return (
    a.baseUrl === b.baseUrl &&
    a.id === b.id &&
    a.created_at === b.created_at &&
    a.from_agent === b.from_agent &&
    a.contentHash === b.contentHash
  )
}

/**
 * Parse skipped.json: keeps only well-formed entries for `baseUrl`. The old
 * id-only format (bare numbers) and entries of another dashboard are dropped.
 */
export function parseSkipEntries(raw: unknown, baseUrl: string): SkipEntry[] {
  if (!Array.isArray(raw)) return []
  return raw.filter(
    (e): e is SkipEntry =>
      !!e &&
      typeof e === 'object' &&
      (e as SkipEntry).baseUrl === baseUrl &&
      typeof (e as SkipEntry).id === 'number' &&
      typeof (e as SkipEntry).created_at === 'number' &&
      typeof (e as SkipEntry).from_agent === 'string' &&
      typeof (e as SkipEntry).contentHash === 'string',
  )
}

export function isSkipped(
  row: Pick<MessageRow, 'id' | 'created_at' | 'from_agent' | 'content'>,
  entries: readonly SkipEntry[],
  baseUrl: string,
): boolean {
  const fp = skipEntryFor(row, baseUrl)
  return entries.some(e => sameSkip(e, fp))
}

/** Add (or move to the end) an entry; keep the newest `max`. */
export function addSkipEntry(entries: readonly SkipEntry[], entry: SkipEntry, max: number): SkipEntry[] {
  return [...entries.filter(e => !sameSkip(e, entry)), entry].slice(-max)
}
