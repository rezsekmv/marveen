import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildOriginNote, computeFolderKey, detectIdentity, type GitRunner } from '../src/identity.ts'

describe('origin_note', () => {
  test('format is `claude-code <repo>@<branch> folder:<key>`', () => {
    expect(buildOriginNote('marveen', 'feat/cc-link', 'abcd1234')).toBe('claude-code marveen@feat/cc-link folder:abcd1234')
  })

  test('very long repo/branch: <= 120 chars and still ends with ` folder:<key>`', () => {
    const cases: Array<[string, string]> = [
      ['r'.repeat(300), 'main'],
      ['repo', 'feature/' + 'b'.repeat(400)],
      ['ű'.repeat(90), 'á'.repeat(90)],
      ['x'.repeat(109), 'y'],
    ]
    for (const [repo, branch] of cases) {
      const note = buildOriginNote(repo, branch, '0a1b2c3d')
      expect(note.length).toBeLessThanOrEqual(120)
      expect(note.endsWith(' folder:0a1b2c3d')).toBe(true)
      expect(note.startsWith('claude-code ')).toBe(true)
      // The server's 120-char cut keeps the key.
      expect(note.slice(0, 120).endsWith(' folder:0a1b2c3d')).toBe(true)
    }
  })

  test('exactly at the limit is left alone; one over is truncated with an ellipsis', () => {
    const key = 'deadbeef'
    const room = 120 - 'claude-code '.length - ` folder:${key}`.length - '@b'.length
    const fits = buildOriginNote('r'.repeat(room), 'b', key)
    expect(fits.length).toBe(120)
    expect(fits).not.toContain('…')
    const over = buildOriginNote('r'.repeat(room + 1), 'b', key)
    expect(over.length).toBeLessThanOrEqual(120)
    expect(over).toContain('…')
    expect(over.endsWith(` folder:${key}`)).toBe(true)
  })
})

describe('folder key', () => {
  let dir: string
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'cc-link-id-'))))
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  test('8 hex chars, stable per path, different for different paths', () => {
    const a = computeFolderKey('/work/a')
    expect(a).toMatch(/^[0-9a-f]{8}$/)
    expect(computeFolderKey('/work/a')).toBe(a)
    expect(computeFolderKey('/work/b')).not.toBe(a)
  })

  test('detectIdentity: no git -> realpath(cwd); a symlinked path gives the same key', () => {
    const real = join(dir, 'proj')
    mkdirSync(real)
    const link = join(dir, 'link')
    symlinkSync(real, link)
    const noGit: GitRunner = () => undefined
    const viaReal = detectIdentity(real, noGit)
    const viaLink = detectIdentity(link, noGit)
    expect(viaReal.folderKey).toMatch(/^[0-9a-f]{8}$/)
    expect(viaLink.folderKey).toBe(viaReal.folderKey)
    expect(viaReal.folderKey).toBe(computeFolderKey(realpathSync(real)))
    expect(viaReal.branch()).toBe('-')
    expect(viaReal.originNote()).toBe(`claude-code proj@- folder:${viaReal.folderKey}`)
  })

  test('detectIdentity: git top-level decides the folder; branch re-read on every call; detached HEAD -> short sha', () => {
    const top = join(dir, 'repo')
    mkdirSync(join(top, 'sub', 'deep'), { recursive: true })
    let branch = 'main'
    const git: GitRunner = args => {
      if (args.includes('--show-toplevel')) return top
      if (args.includes('--abbrev-ref')) return branch
      if (args.includes('--short')) return 'a1b2c3d'
      return undefined
    }
    const fromTop = detectIdentity(top, git)
    const fromSub = detectIdentity(join(top, 'sub', 'deep'), git)
    expect(fromSub.folderKey).toBe(fromTop.folderKey)
    expect(fromTop.repo).toBe('repo')
    expect(fromTop.originNote()).toBe(`claude-code repo@main folder:${fromTop.folderKey}`)
    branch = 'feat/other'
    expect(fromTop.originNote()).toBe(`claude-code repo@feat/other folder:${fromTop.folderKey}`)
    branch = 'HEAD'
    expect(fromTop.branch()).toBe('a1b2c3d')
  })
})

describe('origin_note marker hygiene (M4)', () => {
  test('a ":" in repo or branch cannot forge a second folder:<key> marker', () => {
    const note = buildOriginNote('folder:deadbeef', 'x', '0a1b2c3d')
    expect(note).toBe('claude-code folder_deadbeef@x folder:0a1b2c3d')
  })
})
