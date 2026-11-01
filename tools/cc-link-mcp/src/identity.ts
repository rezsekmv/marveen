/**
 * Session identity: which folder (git top-level or cwd) this session works in,
 * its short folder key, and the origin_note that carries the key to the
 * dashboard. The builders are pure; detection takes an injectable git runner.
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { basename } from 'node:path'

/** The dashboard cuts origin_note at this many characters. */
export const ORIGIN_NOTE_MAX = 120
export const ORIGIN_NOTE_PREFIX = 'claude-code'
const ELLIPSIS = '…'

/** First 8 hex chars of sha256(realpath(folder)). */
export function computeFolderKey(realFolder: string): string {
  return createHash('sha256').update(realFolder).digest('hex').slice(0, 8)
}

/** Explicit marker that carries the folder key in origin_note: `folder:<8 hex>`. */
export const FOLDER_MARKER = 'folder:'

/**
 * Whitespace would split repo@branch into several tokens; ':' could forge a
 * second `folder:<key>` marker from a repo or branch name (git refs cannot
 * contain ':' anyway).
 */
export function sanitizeLabel(s: string): string {
  const cleaned = s.replace(/\s+/g, '_').replace(/:/g, '_')
  return cleaned.length > 0 ? cleaned : '-'
}

/**
 * `claude-code <repo>@<branch> folder:<folderKey>`, never longer than `max`.
 * When too long, the `<repo>@<branch>` part is truncated with an ellipsis so
 * the trailing ` folder:<folderKey>` marker ALWAYS survives the server-side cut.
 */
export function buildOriginNote(repo: string, branch: string, folderKey: string, max = ORIGIN_NOTE_MAX): string {
  const label = `${sanitizeLabel(repo)}@${sanitizeLabel(branch)}`
  const head = `${ORIGIN_NOTE_PREFIX} `
  const tail = ` ${FOLDER_MARKER}${folderKey}`
  const full = head + label + tail
  if (full.length <= max) return full
  const room = max - head.length - tail.length - ELLIPSIS.length
  if (room <= 0) return `${FOLDER_MARKER}${folderKey}`
  return head + label.slice(0, room) + ELLIPSIS + tail
}

/** Local `YYYY-MM-DD HH:MM`. */
export function formatLocalTimestamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** Runs git with the given args in `cwd`; returns trimmed stdout or undefined on any failure. */
export type GitRunner = (args: string[], cwd: string) => string | undefined

export const defaultGitRunner: GitRunner = (args, cwd) => {
  try {
    const out = execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
    }).trim()
    return out.length > 0 ? out : undefined
  } catch {
    return undefined
  }
}

export interface SessionIdentity {
  /** realpath of the git top-level, or of cwd when not in a repo. */
  folder: string
  repo: string
  folderKey: string
  isGitRepo: boolean
  /** Re-read on every call: the branch can change during a session. */
  branch(): string
  originNote(): string
}

function safeRealpath(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

export function detectIdentity(cwd: string = process.cwd(), git: GitRunner = defaultGitRunner): SessionIdentity {
  const top = git(['rev-parse', '--show-toplevel'], cwd)
  const folder = safeRealpath(top ?? cwd)
  const isGitRepo = top !== undefined
  const repo = sanitizeLabel(basename(folder) || folder)
  const folderKey = computeFolderKey(folder)
  const branch = (): string => {
    if (!isGitRepo) return '-'
    const b = git(['rev-parse', '--abbrev-ref', 'HEAD'], folder)
    if (b && b !== 'HEAD') return b
    return git(['rev-parse', '--short', 'HEAD'], folder) ?? '-'
  }
  return {
    folder,
    repo,
    folderKey,
    isGitRepo,
    branch,
    originNote: () => buildOriginNote(repo, branch(), folderKey),
  }
}
