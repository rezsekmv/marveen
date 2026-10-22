// Per-device dashboard keys (AUTHPLAN1 #1).
//
// A device key is a long-lived Bearer credential minted for ONE device (a
// Bridge install, a phone) so it can be revoked alone, without rotating the
// shared dashboard token that every fleet script embeds. Modeled on
// auth-sessions.ts: only sha256(key) is stored -- in the DB (device_keys) and
// the in-memory cache -- so neither a DB leak nor a heap dump yields a usable
// credential.
//
// Differences from sessions, both deliberate:
//   - No idle/absolute TTL by default. A rarely used phone must not die
//     silently; expiry is per-key OPT-IN (expires_at) chosen at mint time.
//   - The principal is the device itself (name + id), not a user.
//
// Zero rows = the feature is off: resolveDeviceKey misses and the gate falls
// through exactly as before, so a byte-copy fresh install is unaffected.
//
// What a device key may DO is decided elsewhere: the gate hands out
// { kind: 'device' } and the per-endpoint allowlists (routes/auth.ts) deny it
// on every access-granting path -- a device can use the dashboard, it can
// never mint users, keys, or reset passwords.

import { randomBytes, createHash } from 'node:crypto'
import { getDb } from '../db.js'

const LAST_USED_DEBOUNCE_SEC = 60

// Prefix makes a leaked credential recognizable in logs/repos (secret
// scanners) and visually distinct from the 64-hex dashboard token.
const KEY_PREFIX = 'mvdk_'

/**
 * What a key may reach (DASHOPERATOR1005). 'full' is every key minted before
 * this field existed and stays the default. 'operator' is the IT operator's
 * key: the gate lets it reach /api/operator/* only (operator-gate.ts), and it
 * must expire -- an operator key without an end date cannot be minted.
 */
export type DeviceKeyScope = 'full' | 'operator' | 'messages'
export const DEVICE_KEY_SCOPES: readonly DeviceKeyScope[] = ['full', 'operator', 'messages']
export const OPERATOR_KEY_DEFAULT_EXPIRY_DAYS = 90
/** An operator key lives at most a year (owner decision 2026-10-05; a full key keeps its own ceiling). */
export const OPERATOR_KEY_MAX_EXPIRY_DAYS = 365

/**
 * 'messages' (cc-link): a laptop link that only needs to post and read its own
 * mailbox. Before it existed such a link had to carry a FULL key, so every
 * route a full key reaches (memories, kanban, vault, agent control) sat on a
 * roaming laptop just to send chat rows. The key is
 * bound to ONE system sender id at mint time, and messages-gate.ts lets it reach
 * the message API as that sender only. Same expiry rules as an operator key:
 * a narrow credential that lives on a roaming machine must not live forever.
 */
export const MESSAGES_KEY_DEFAULT_EXPIRY_DAYS = OPERATOR_KEY_DEFAULT_EXPIRY_DAYS
export const MESSAGES_KEY_MAX_EXPIRY_DAYS = OPERATOR_KEY_MAX_EXPIRY_DAYS

/** Scopes that cannot be minted without an end date. A full key keeps opt-in expiry. */
export function scopeMustExpire(scope: DeviceKeyScope): boolean {
  return scope === 'operator' || scope === 'messages'
}

export interface DeviceKeyPrincipal {
  id: number
  name: string
  scope: DeviceKeyScope
  /** The one sender id a 'messages' key may act as; absent for every other scope. */
  senderId?: string
}

export interface DeviceKeyInfo {
  id: number
  name: string
  createdAt: number
  lastUsedAt: number | null
  expiresAt: number | null
  /** SSH enrollment id (marveen-remote:<uuid>) for Bridge-paired keys; null
   *  for keys minted outside the pairing flow. */
  installId: string | null
  /** 'unknown' = a stored value this build does not know; such a key does not
   *  authenticate at all (see toScope). Listed so the owner can see and revoke it. */
  scope: DeviceKeyScope | 'unknown'
  /** The bound sender id of a 'messages' key; null for every other scope. */
  senderId: string | null
}

export interface MintedDeviceKey extends DeviceKeyInfo {
  /** The raw credential. Returned ONCE at mint time, never recoverable. */
  key: string
}

interface CachedKey {
  id: number
  name: string
  lastUsedAt: number | null
  expiresAt: number | null
  scope: DeviceKeyScope
  senderId: string | null
}

// Fail closed: only an exact, known scope string is that scope. An UNKNOWN
// stored value (a typo, a hand edit, or a scope a NEWER build minted) is null,
// and resolveDeviceKey then refuses the key outright: no access at all, never
// the "narrowest" known scope. Mapping unknown -> operator was the old rule,
// and it is a rollback hazard (security re-review of cc-link): every build before
// 2a59547a reads a 'messages' key as 'operator'.
//
// ROLLBACK NOTE: before rolling the dashboard back to a build older than
// 2a59547a (the commit that added the 'messages' scope), revoke every
// 'messages' scoped device key (GET /api/auth/device-keys, then DELETE
// /api/auth/device-keys/<id>). Those older builds map any scope other than
// 'full' to 'operator', so a surviving messages key would become an operator
// key there (reaching /api/operator/* whenever the owner has operator access
// on). Builds from this one on deny an unknown scope instead, so rolling back
// from a FUTURE scope to this build is safe without that step.
// A messages row without a sender_id is still 'messages', and the messages
// gate denies such a key everything.
function toScope(value: unknown): DeviceKeyScope | null {
  if (value === 'full' || value === 'operator' || value === 'messages') return value
  return null
}

const cache = new Map<string, CachedKey>()

function sha256hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000)
}

// Mint a new key. The raw value exists only in the returned object; the row
// stores its hash. expiresInDays is opt-in -- omitted means the key lives until
// revoked.
export function createDeviceKey(name: string, opts: { expiresInDays?: number; installId?: string; scope?: DeviceKeyScope; senderId?: string } = {}): MintedDeviceKey {
  const scope = opts.scope ?? 'full'
  if (scopeMustExpire(scope) && !(opts.expiresInDays && opts.expiresInDays > 0)) {
    throw new Error(`an ${scope} key must expire`)
  }
  if (scope === 'operator' && opts.expiresInDays! > OPERATOR_KEY_MAX_EXPIRY_DAYS) {
    throw new Error(`an operator key lives at most ${OPERATOR_KEY_MAX_EXPIRY_DAYS} days`)
  }
  if (scope === 'messages' && opts.expiresInDays! > MESSAGES_KEY_MAX_EXPIRY_DAYS) {
    throw new Error(`a messages key lives at most ${MESSAGES_KEY_MAX_EXPIRY_DAYS} days`)
  }
  // The binding is all-or-nothing: a messages key without a sender could act as
  // nobody (useless), and a sender on any other scope would be a field nothing
  // enforces. The route validates WHICH ids are allowed; this is the invariant.
  if (scope === 'messages' && !opts.senderId) throw new Error('a messages key must be bound to a sender id')
  if (scope !== 'messages' && opts.senderId !== undefined) throw new Error('only a messages key carries a sender id')
  const senderId = opts.senderId ?? null
  const raw = KEY_PREFIX + randomBytes(32).toString('base64url')
  const keyHash = sha256hex(raw)
  const now = nowSec()
  const expiresAt = opts.expiresInDays ? now + Math.floor(opts.expiresInDays * 24 * 60 * 60) : null
  const installId = opts.installId ?? null
  const info = getDb()
    .prepare('INSERT INTO device_keys (key_hash, name, created_at, last_used_at, expires_at, install_id, scope, sender_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(keyHash, name, now, null, expiresAt, installId, scope, senderId)
  const id = Number(info.lastInsertRowid)
  cache.set(keyHash, { id, name, lastUsedAt: null, expiresAt, scope, senderId })
  return { id, name, createdAt: now, lastUsedAt: null, expiresAt, installId, scope, senderId, key: raw }
}

function removeByHash(keyHash: string): void {
  cache.delete(keyHash)
  getDb().prepare('DELETE FROM device_keys WHERE key_hash = ?').run(keyHash)
}

// Validate a presented raw key. Returns the device principal or null. Enforces
// the opt-in expiry and debounces the last_used write to <= once per 60s. The
// cache is hydrated lazily from SQLite so keys survive dashboard restarts.
export function resolveDeviceKey(raw: string): DeviceKeyPrincipal | null {
  if (!raw || !raw.startsWith(KEY_PREFIX)) return null
  const keyHash = sha256hex(raw)
  let entry = cache.get(keyHash)
  if (!entry) {
    const row = getDb()
      .prepare('SELECT id, name, last_used_at, expires_at, scope, sender_id FROM device_keys WHERE key_hash = ?')
      .get(keyHash) as { id: number; name: string; last_used_at: number | null; expires_at: number | null; scope: string; sender_id: string | null } | undefined
    if (!row) return null
    const scope = toScope(row.scope)
    if (!scope) return null // unknown scope: no access (see toScope), not cached
    entry = { id: row.id, name: row.name, lastUsedAt: row.last_used_at, expiresAt: row.expires_at, scope, senderId: row.sender_id ?? null }
    cache.set(keyHash, entry)
  }
  const now = nowSec()
  if (entry.expiresAt !== null && now > entry.expiresAt) {
    removeByHash(keyHash)
    return null
  }
  if (entry.lastUsedAt === null || now - entry.lastUsedAt >= LAST_USED_DEBOUNCE_SEC) {
    entry.lastUsedAt = now
    const res = getDb().prepare('UPDATE device_keys SET last_used_at = ? WHERE key_hash = ?').run(now, keyHash)
    // The debounced write doubles as an existence check: zero changed rows
    // means the key was revoked OUTSIDE this process (dashboard-user
    // security:reset runs in its own process and cannot reach this cache), so
    // an out-of-band revocation takes effect here within <=60s instead of
    // lingering until the next restart.
    if (res.changes === 0) {
      cache.delete(keyHash)
      return null
    }
  }
  // senderId is surfaced for a messages key ONLY: a stray value on another
  // scope must never become an identity a route could read.
  return entry.scope === 'messages' && entry.senderId
    ? { id: entry.id, name: entry.name, scope: entry.scope, senderId: entry.senderId }
    : { id: entry.id, name: entry.name, scope: entry.scope }
}

function rowToInfo(r: { id: number; name: string; created_at: number; last_used_at: number | null; expires_at: number | null; install_id: string | null; scope: string; sender_id: string | null }): DeviceKeyInfo {
  return { id: r.id, name: r.name, createdAt: r.created_at, lastUsedAt: r.last_used_at, expiresAt: r.expires_at, installId: r.install_id, scope: toScope(r.scope) ?? 'unknown', senderId: r.sender_id ?? null }
}

const INFO_COLUMNS = 'id, name, created_at, last_used_at, expires_at, install_id, scope, sender_id'

export function listDeviceKeys(): DeviceKeyInfo[] {
  const rows = getDb()
    .prepare(`SELECT ${INFO_COLUMNS} FROM device_keys ORDER BY created_at DESC`)
    .all() as Parameters<typeof rowToInfo>[0][]
  return rows.map(rowToInfo)
}

export function getDeviceKey(id: number): DeviceKeyInfo | null {
  const row = getDb().prepare(`SELECT ${INFO_COLUMNS} FROM device_keys WHERE id = ?`).get(id) as Parameters<typeof rowToInfo>[0] | undefined
  return row ? rowToInfo(row) : null
}

/** Bridge re-pairing: find the key minted by a previous enrollment of the same
 *  device (same marveen-remote:<uuid>), so it can be replaced, not duplicated. */
export function findDeviceKeyByInstallId(installId: string): DeviceKeyInfo | null {
  const row = getDb().prepare(`SELECT ${INFO_COLUMNS} FROM device_keys WHERE install_id = ?`).get(installId) as Parameters<typeof rowToInfo>[0] | undefined
  return row ? rowToInfo(row) : null
}

// Revocation is immediate: the row and any cached entry go together, so the
// very next request with the key falls through the gate.
export function revokeDeviceKey(id: number): boolean {
  const res = getDb().prepare('DELETE FROM device_keys WHERE id = ?').run(id)
  for (const [hash, entry] of cache) {
    if (entry.id === id) cache.delete(hash)
  }
  return res.changes > 0
}

// Nuclear option for the security:reset break-glass path (#5): every device
// loses access at once. Returns the number of keys revoked.
export function revokeAllDeviceKeys(): number {
  const res = getDb().prepare('DELETE FROM device_keys').run()
  cache.clear()
  return res.changes
}

// Hourly sweep of keys past their (opt-in) expiry, alongside the session sweep.
// Keys without expires_at are never touched.
export function sweepExpiredDeviceKeys(): number {
  const now = nowSec()
  const res = getDb().prepare('DELETE FROM device_keys WHERE expires_at IS NOT NULL AND expires_at < ?').run(now)
  for (const [hash, entry] of cache) {
    if (entry.expiresAt !== null && entry.expiresAt < now) cache.delete(hash)
  }
  return res.changes
}

// Test seam: drop the in-memory cache to simulate a process restart (durable
// rows in device_keys must still resolve afterwards).
export function _clearDeviceKeyCacheForTest(): void {
  cache.clear()
}

// Test seam: direct cache access, so tests can age a last_used stamp across
// the debounce window without sleeping.
export const _cacheForTest = cache
