/**
 * Small filesystem helpers: atomic JSON writes and a pid lock file.
 *
 * Lock protocol:
 * - Acquire: write the pid to a unique temp file, then link() it to the lock
 *   path. link() fails with EEXIST when the lock exists, so the lock appears
 *   atomically WITH its content: no reader ever sees an empty lock.
 * - Stale: the lock predates the last boot (pid reuse makes its pid
 *   meaningless), or its pid is dead. Otherwise a live pid is never stale, however old the
 *   file (a long holder touches it anyway, see LockHandle.touch). Only a lock
 *   whose pid cannot be read falls back to age: stale once older than
 *   UNPARSABLE_LOCK_STALE_MS (with atomic creation that only happens after
 *   corruption, so a short grace is enough).
 * - Stale removal: rename the lock to a unique name, verify the renamed file
 *   is the one judged stale (same inode, else same pid + mtime), and only then
 *   delete it. If a different lock was moved, put it back.
 */
import {
  closeSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { dirname } from 'node:path'
import { uptime } from 'node:os'
import { randomBytes } from 'node:crypto'

export type IsAlive = (pid: number) => boolean
export type Now = () => number

/**
 * process.kill(pid, 0): ESRCH means dead; EPERM means alive but not ours (correct
 * for a live foreign process). A pid reused after a reboot also reads as alive:
 * the boot rule (bootMs) covers that case for locks and asks.
 */
export const defaultIsAlive: IsAlive = pid => {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Epoch ms of the last boot (Date.now() - os.uptime()). */
export function defaultBootMs(): number {
  return Date.now() - uptime() * 1000
}

export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
}

const rand = () => randomBytes(6).toString('hex')

/** Write tmp + rename, so readers never see a half-written file. */
export function atomicWriteJson(path: string, data: unknown): void {
  ensureDir(dirname(path))
  const tmp = `${path}.${process.pid}.${rand()}.tmp`
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, path)
}

export function readJsonFile<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return fallback
  }
}

export interface LockOptions {
  isAlive?: IsAlive
  now?: Now
  /** Age after which a lock with an UNREADABLE pid is stale (default UNPARSABLE_LOCK_STALE_MS). */
  unparsableStaleMs?: number
  /** How long to keep retrying a held lock; 0 = single attempt (default 5 000). */
  waitMs?: number
  /** Pid written into the lock (default process.pid). */
  pid?: number
  sleep?: (ms: number) => Promise<void>
  /**
   * Epoch ms of the last boot (default defaultBootMs()). A lock whose mtime is
   * older is stale regardless of its pid: after a reboot the pid may have been
   * reused by an unrelated live process, which would wedge the lock forever.
   */
  bootMs?: number
}

export const UNPARSABLE_LOCK_STALE_MS = 5_000

const defaultSleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

interface LockInfo {
  ino: number
  mtimeMs: number
  pid: number | undefined
}

/** The lock path is unusable (a directory, no permission, a file where a directory should be). */
export class LockPathError extends Error {
  constructor(path: string, code: string | undefined, detail?: string) {
    super(`cannot use lock file ${path}: ${code ?? 'error'}${detail ? ` (${detail})` : ''}`)
    this.name = 'LockPathError'
  }
}

const FATAL_LOCK_CODES = new Set(['EISDIR', 'EACCES', 'EPERM', 'ENOTDIR', 'EROFS', 'ELOOP', 'ENAMETOOLONG'])

function lockFsError(path: string, err: unknown): Error {
  const code = (err as NodeJS.ErrnoException).code
  return code && FATAL_LOCK_CODES.has(code) ? new LockPathError(path, code) : (err as Error)
}

/** undefined only when the lock does not exist; an unusable lock path throws LockPathError. */
function readLockInfo(path: string): LockInfo | undefined {
  try {
    const st = statSync(path)
    if (st.isDirectory()) throw new LockPathError(path, 'EISDIR', 'the lock path is a directory')
    const raw = readFileSync(path, 'utf8').trim()
    const pid = /^\d+$/.test(raw) ? parseInt(raw, 10) : undefined
    return { ino: st.ino, mtimeMs: st.mtimeMs, pid }
  } catch (err) {
    if (err instanceof LockPathError) throw err
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw lockFsError(path, err)
  }
}

function safeReadLockInfo(path: string): LockInfo | undefined {
  try {
    return readLockInfo(path)
  } catch {
    return undefined
  }
}

function infoIsStale(info: LockInfo, opts: LockOptions): boolean {
  if (info.mtimeMs < (opts.bootMs ?? defaultBootMs())) return true
  const isAlive = opts.isAlive ?? defaultIsAlive
  if (info.pid !== undefined) return !isAlive(info.pid)
  const now = opts.now ?? Date.now
  return now() - info.mtimeMs > (opts.unparsableStaleMs ?? UNPARSABLE_LOCK_STALE_MS)
}

/** Is the existing lock at `path` stale? A missing lock is reported as not stale (nothing to remove). */
export function isLockStale(path: string, opts: LockOptions = {}): boolean {
  const info = safeReadLockInfo(path)
  return info !== undefined && infoIsStale(info, opts)
}

/**
 * Remove the lock only if it is still the very file judged stale.
 * Returns true when a stale lock was removed.
 */
function removeIfSame(path: string, judged: LockInfo): boolean {
  const aside = `${path}.stale.${process.pid}.${rand()}`
  try {
    renameSync(path, aside)
  } catch {
    return false // gone or replaced meanwhile: just retry the acquisition
  }
  const moved = safeReadLockInfo(aside)
  const same =
    moved !== undefined &&
    (moved.ino === judged.ino || (moved.pid === judged.pid && moved.mtimeMs === judged.mtimeMs))
  if (same) {
    try {
      unlinkSync(aside)
    } catch {
      // ignore
    }
    return true
  }
  // We moved someone else's fresh lock: put it back (fails only if yet another lock exists).
  try {
    linkSync(aside, path)
  } catch {
    // a newer lock already took the slot; the moved one is superseded
  }
  try {
    unlinkSync(aside)
  } catch {
    // ignore
  }
  return false
}

export interface LockHandle {
  release(): void
  /** Refresh the lock's mtime; call before each slow (network) step while holding it. */
  touch(): void
}

/** Immediate retries (after a stale lock was removed or the lock vanished) before sleeping. */
const MAX_IMMEDIATE_RETRIES = 10

/**
 * Try to take the lock; returns a handle, or null if it is held by a live
 * process past `waitMs`. The deadline is wall-clock and always enforced; an
 * unusable lock path (directory, no permission, ...) throws LockPathError at once.
 */
export async function acquireLock(path: string, opts: LockOptions = {}): Promise<LockHandle | null> {
  const pid = opts.pid ?? process.pid
  const waitMs = opts.waitMs ?? 5_000
  const sleep = opts.sleep ?? defaultSleep
  const deadline = Date.now() + waitMs
  let immediate = 0
  try {
    ensureDir(dirname(path))
  } catch (err) {
    throw lockFsError(dirname(path), err)
  }
  for (;;) {
    const tmp = `${path}.${pid}.${rand()}.tmp`
    try {
      const fd = openSync(tmp, 'wx', 0o600)
      try {
        writeSync(fd, String(pid))
      } finally {
        closeSync(fd)
      }
    } catch (err) {
      throw lockFsError(tmp, err)
    }
    let got = false
    try {
      linkSync(tmp, path)
      got = true
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        try {
          unlinkSync(tmp)
        } catch {
          // ignore
        }
        throw lockFsError(path, err)
      }
    }
    let ino = -1
    if (got) {
      try {
        ino = statSync(tmp).ino
      } catch {
        // ignore
      }
    }
    try {
      unlinkSync(tmp)
    } catch {
      // ignore
    }
    if (got) {
      return {
        release: () => {
          const info = safeReadLockInfo(path)
          if (info && (info.ino === ino || info.pid === pid)) {
            try {
              unlinkSync(path)
            } catch {
              // already gone
            }
          }
        },
        touch: () => {
          try {
            const t = new Date()
            utimesSync(path, t, t)
          } catch {
            // ignore
          }
        },
      }
    }
    const info = readLockInfo(path) // throws LockPathError for a directory / no permission
    if (info === undefined || infoIsStale(info, opts)) {
      // Vanished between link and read, or stale: retry at once, a bounded number of times.
      if (info !== undefined) removeIfSame(path, info)
      if (++immediate <= MAX_IMMEDIATE_RETRIES) continue
    }
    if (Date.now() >= deadline) return null
    immediate = 0
    await sleep(50)
  }
}

export class LockBusyError extends Error {
  constructor(path: string) {
    super(`lock busy: ${path}`)
    this.name = 'LockBusyError'
  }
}

/** Run `fn` holding the lock; throws LockBusyError if it cannot be taken in time. */
export async function withLock<T>(path: string, fn: (lock: LockHandle) => Promise<T> | T, opts: LockOptions = {}): Promise<T> {
  const handle = await acquireLock(path, opts)
  if (!handle) throw new LockBusyError(path)
  try {
    return await fn(handle)
  } finally {
    handle.release()
  }
}
