/**
 * Disk outbox for sends that hit a network error, timeout or 5xx.
 *
 * Layout under `dir`:
 *   <epoch-ms>-<rand>.json   one pending item, names sort by creation
 *   .lock                    global flush lock (same stale rule as folder locks)
 *   rejected/                items the server refused with a 4xx
 *   errors.log               one line per rejection (file name, status, error text)
 *   flush.log                one line per flush attempt (counts only)
 *
 * Logs never contain the device key or message bodies.
 */
import { appendFileSync, existsSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { acquireLock, ensureDir, type LockOptions, type Now } from './fsutil.ts'
import { ApiError, type MessageRow, type PostMessageBody } from './api.ts'
import { hasRefToken } from './format.ts'

export interface OutboxItem {
  createdAt: string
  kind: 'note' | 'ask'
  folderKey: string
  pid: number
  /** The FULL POST /api/messages body. */
  payload: PostMessageBody
  /** Random id of this item (assigned on enqueue); for logs. */
  itemId?: string
  /** Idempotency token carried in the content's header line as `ref:<token>`. */
  token?: string
  /**
   * A previous attempt may have reached the server (timeout, network error
   * after sending, 5xx). Before resending, the flush checks the server for an
   * identical row and, if found, treats the item as sent (the server has no
   * idempotency key).
   */
  uncertain?: boolean
}

/**
 * Pure: the id of a row that is this item already delivered, matched ONLY by
 * the item's idempotency token: a row from our sender to the same recipient
 * whose content carries `ref:<token>`. Text equality and timestamps are not
 * used (the server may rewrite content; clocks may differ), so two notes with
 * identical text are never confused. Items without a token never match.
 */
export function findDuplicateRow(
  rows: readonly MessageRow[],
  item: Pick<OutboxItem, 'payload' | 'token'>,
): number | undefined {
  const token = item.token
  if (!token) return undefined
  const p = item.payload
  const matches = rows.filter(
    r => r.from_agent === p.from && r.to_agent === p.to && typeof r.content === 'string' && hasRefToken(r.content, token),
  )
  matches.sort((a, b) => a.id - b.id)
  return matches[0]?.id
}

/** How many of the sender's newest rows the dedup check reads. */
export const DEDUP_LOOKBACK = 200

export interface FlushSent {
  file: string
  id: number
  item: OutboxItem
}

export interface FlushResult {
  /** True when another process held the flush lock; nothing was attempted. */
  skipped: boolean
  sent: FlushSent[]
  /** Items that hit a retryable or auth error (0 or 1: flushing stops at the first). */
  failed: number
  /** The flush stopped on 401/403: nothing was rejected, the outbox is kept. */
  authError: boolean
  rejected: string[]
  remaining: number
  /** Items found already delivered on the server (uncertain resend avoided). */
  deduped: number
}

export const WEEK_MS = 7 * 24 * 60 * 60 * 1000
const ITEM_NAME = /^\d+-[0-9a-f]+\.json$/

export interface OutboxOptions {
  now?: Now
  lock?: LockOptions
  random?: () => string
}

export type SendFn = (payload: PostMessageBody) => Promise<{ id: number }>
export type OnSentFn = (sent: FlushSent) => Promise<void> | void
/** Look for an already-delivered copy of an uncertain item; returns its id. Throwing stops the flush (retryable). */
export type FindExistingFn = (item: OutboxItem) => Promise<number | undefined>

export interface FlushOptions {
  onSent?: OnSentFn
  findExisting?: FindExistingFn
  /** Wait this long for another process's flush lock instead of skipping (default 0 = skip). */
  waitMs?: number
}

export class Outbox {
  readonly dir: string
  readonly rejectedDir: string
  readonly lockPath: string
  private readonly now: Now
  private readonly lockOpts: LockOptions
  private readonly random: () => string

  constructor(dir: string, opts: OutboxOptions = {}) {
    this.dir = dir
    this.rejectedDir = join(dir, 'rejected')
    this.lockPath = join(dir, '.lock')
    this.now = opts.now ?? Date.now
    // A flush never waits for another session's flush: it just skips this round.
    this.lockOpts = { waitMs: 0, now: this.now, ...opts.lock }
    this.random = opts.random ?? (() => randomBytes(4).toString('hex'))
  }

  /** Pending item file names in send order. */
  list(): string[] {
    try {
      return readdirSync(this.dir).filter(n => ITEM_NAME.test(n)).sort(compareNames)
    } catch {
      return []
    }
  }

  count(): number {
    return this.list().length
  }

  read(file: string): OutboxItem | undefined {
    try {
      return JSON.parse(readFileSync(join(this.dir, file), 'utf8')) as OutboxItem
    } catch {
      return undefined
    }
  }

  /** Number of pending items created more than `ageMs` ago (by item createdAt, else file name). */
  countOlderThan(ageMs: number = WEEK_MS): number {
    const cutoff = this.now() - ageMs
    let n = 0
    for (const f of this.list()) {
      const item = this.read(f)
      const t = item ? Date.parse(item.createdAt) : NaN
      const created = Number.isFinite(t) ? t : parseInt(f, 10)
      if (created < cutoff) n++
    }
    return n
  }

  rejectedNames(): string[] {
    try {
      return readdirSync(this.rejectedDir).filter(n => n.endsWith('.json')).sort(compareNames)
    } catch {
      return []
    }
  }

  /** Write a new item atomically; returns its file name. */
  enqueue(item: OutboxItem): string {
    ensureDir(this.dir)
    // Names must sort in creation order: never reuse or go below the newest pending ms.
    const last = this.list().at(-1)
    let ms = Math.max(this.now(), last ? parseInt(last, 10) + 1 : 0)
    let name = `${ms}-${this.random()}.json`
    while (existsSync(join(this.dir, name))) {
      ms++
      name = `${ms}-${this.random()}.json`
    }
    const tmp = join(this.dir, `.${name}.tmp`)
    const full: OutboxItem = { ...item, itemId: item.itemId ?? `${this.random()}${this.random()}` }
    writeFileSync(tmp, JSON.stringify(full, null, 2) + '\n', { mode: 0o600 })
    renameSync(tmp, join(this.dir, name))
    return name
  }

  /**
   * Send items in order. Success: delete the file, then `onSent`. Retryable
   * failure or 401/403: stop, keep the rest. Other 4xx, or a POST whose 2xx
   * response was unreadable (send state unknown, never resent): move to
   * rejected/ and log, continue.
   */
  async flush(send: SendFn, opts: FlushOptions | OnSentFn = {}): Promise<FlushResult> {
    const o: FlushOptions = typeof opts === 'function' ? { onSent: opts } : opts
    const onSent = o.onSent
    ensureDir(this.dir)
    const lock = await acquireLock(this.lockPath, { ...this.lockOpts, ...(o.waitMs ? { waitMs: o.waitMs } : {}) })
    if (!lock) {
      return { skipped: true, sent: [], failed: 0, authError: false, rejected: [], remaining: this.count(), deduped: 0 }
    }
    const result: FlushResult = {
      skipped: false,
      sent: [],
      failed: 0,
      authError: false,
      rejected: [],
      remaining: 0,
      deduped: 0,
    }
    try {
      for (const file of this.list()) {
        const path = join(this.dir, file)
        const item = this.read(file)
        if (!item || !item.payload) {
          this.reject(file, undefined, 'unreadable outbox item')
          result.rejected.push(file)
          continue
        }
        try {
          lock.touch()
          let row: { id: number } | undefined
          if (item.uncertain && o.findExisting) {
            let existing: number | undefined
            try {
              existing = await o.findExisting(item)
            } catch (lookupErr) {
              // A failed duplicate check is not this item's fault: keep it and stop
              // the flush (retryable), never reject a message that may be undelivered.
              if (lookupErr instanceof ApiError && lookupErr.isAuth) throw lookupErr
              throw new ApiError(`duplicate check failed: ${errMsg(lookupErr)}`, true)
            }
            if (existing !== undefined) {
              row = { id: existing }
              result.deduped++
            }
            lock.touch()
          }
          row ??= await send(item.payload)
          try {
            unlinkSync(path)
          } catch {
            // already gone
          }
          const sent = { file, id: row.id, item }
          result.sent.push(sent)
          if (onSent) {
            try {
              await onSent(sent)
            } catch (err) {
              process.stderr.write(`cc-link: outbox onSent for id ${row.id} failed: ${errMsg(err)}\n`)
            }
          }
        } catch (err) {
          if (err instanceof ApiError && err.isAuth) {
            // A key/sender problem is not this item's fault: keep everything, stop.
            result.failed = 1
            result.authError = true
            break
          }
          if (err instanceof ApiError && !err.retryable) {
            this.reject(file, err.status, err.serverText ?? err.message)
            result.rejected.push(file)
            continue
          }
          // Retryable: the request may have reached the server. Mark it, so the
          // next attempt checks for a delivered copy before resending.
          if (!item.uncertain) this.markUncertain(file, item)
          result.failed = 1
          break
        }
      }
    } finally {
      result.remaining = this.count()
      this.appendLog(
        'flush.log',
        `${new Date(this.now()).toISOString()} sent=${result.sent.length} failed=${result.failed} rejected=${result.rejected.length} remaining=${result.remaining}` +
          (result.authError ? ' auth-error' : ''),
      )
      lock.release()
    }
    return result
  }

  private markUncertain(file: string, item: OutboxItem): void {
    const path = join(this.dir, file)
    const tmp = join(this.dir, `.${file}.${this.random()}.tmp`)
    try {
      writeFileSync(tmp, JSON.stringify({ ...item, uncertain: true }, null, 2) + '\n', { mode: 0o600 })
      renameSync(tmp, path)
    } catch {
      // best effort: without the mark the item is resent without a dedup check
    }
  }

  private reject(file: string, status: number | undefined, text: string): void {
    ensureDir(this.rejectedDir)
    try {
      renameSync(join(this.dir, file), join(this.rejectedDir, file))
    } catch {
      // vanished meanwhile
    }
    const clean = text.replace(/\s+/g, ' ').slice(0, 300)
    this.appendLog('errors.log', `${new Date(this.now()).toISOString()} ${file} status=${status ?? '-'} ${clean}`)
  }

  private appendLog(name: string, line: string): void {
    try {
      appendFileSync(join(this.dir, name), line + '\n', { mode: 0o600 })
    } catch {
      // logging must never break a flush
    }
  }
}

function compareNames(a: string, b: string): number {
  const ta = parseInt(a, 10)
  const tb = parseInt(b, 10)
  if (ta !== tb) return ta - tb
  return a < b ? -1 : a > b ? 1 : 0
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
