/**
 * DEVKEYGATE1022 -- the device_keys write gate reaches EVERY agent, the main one
 * included, with no profile switch.
 *
 * Two surfaces, and each is asserted where it actually lives:
 *   - a sub-agent: the FINAL settings file after a re-render, and the boot
 *     migration on a file scaffolded before this change (the HBGATEWIRE826
 *     lesson: assert the written file, not the inject function alone);
 *   - the main agent: the tracked .claude/settings.json, read from the repo.
 *     Its live settings path is the owner's ~/.claude/settings.json, so it is
 *     NEVER rendered here -- agentSettingsPath(MAIN_AGENT_ID) is not even called.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  agentGetsDeviceKeysGate,
  injectDeviceKeysGate,
  ensureGovernanceGateCommands,
  writeAgentSettingsFromProfile,
  agentSettingsPath,
  pythonHookCommand,
  GATE_FAIL_CLOSED_TAG,
  DEVICE_KEYS_GATE_MATCHER,
  DEVICE_KEYS_GATE_SCRIPT,
} from '../web/agent-scaffold.js'
import { listProfileTemplates, loadProfileTemplate, type ProfileTemplate } from '../web/profiles.js'
import { MAIN_AGENT_ID, PROJECT_ROOT } from '../config.js'
import { AGENTS_BASE_DIR } from '../web/agent-config.js'

const TEST_AGENT = 'device-keys-gate-probe'
const agentRoot = (n: string) => join(AGENTS_BASE_DIR, n)

type Ptu = Array<{ matcher?: string; hooks: Array<{ command: string }> }>

function cleanup(): void {
  const root = agentRoot(TEST_AGENT)
  if (!existsSync(root)) return
  // Only ever remove the throwaway directory this test created.
  if (!root.startsWith(join(AGENTS_BASE_DIR, TEST_AGENT))) {
    throw new Error(`refusing: ${root} is outside the agents base dir`)
  }
  if (existsSync(join(root, 'CLAUDE.md')) || existsSync(join(root, 'HANDOFF.md'))) {
    throw new Error(`refusing: ${root} looks like a live agent, not a test checkout`)
  }
  rmSync(root, { recursive: true, force: true })
}

beforeEach(cleanup)
afterEach(cleanup)

function render(profile: ProfileTemplate): Ptu {
  mkdirSync(join(agentRoot(TEST_AGENT), '.claude'), { recursive: true })
  writeAgentSettingsFromProfile(TEST_AGENT, profile)
  return (JSON.parse(readFileSync(agentSettingsPath(TEST_AGENT), 'utf-8')) as { hooks: { PreToolUse: Ptu } })
    .hooks.PreToolUse
}

const gateEntries = (ptu: Ptu) => ptu.filter((e) => JSON.stringify(e).includes(DEVICE_KEYS_GATE_SCRIPT))

describe('scope: every agent, no exemption, no switch', () => {
  it('the predicate is true for the main agent and for sub-agents alike', () => {
    for (const n of [MAIN_AGENT_ID, 'worker-a', 'worker-b', TEST_AGENT]) expect(agentGetsDeviceKeysGate(n)).toBe(true)
  })

  it('the scaffold calls the injector unconditionally (no predicate, no profile flag in front of it)', () => {
    const src = readFileSync(join(PROJECT_ROOT, 'src', 'web', 'agent-scaffold.ts'), 'utf-8')
    expect(src).toMatch(/^ {2}injectDeviceKeysGate\(existing\)$/m)
  })
})

describe('a sub-agent: the FINAL settings file', () => {
  it('every shipped profile renders the gate -- there is nothing to opt into', () => {
    const profiles = listProfileTemplates()
    expect(profiles.length).toBeGreaterThan(0)
    for (const p of profiles) {
      const entries = gateEntries(render(p))
      expect(entries, `profile ${p.id}`).toHaveLength(1)
      expect(entries[0].matcher).toBe(DEVICE_KEYS_GATE_MATCHER)
    }
  })

  it('a second render keeps exactly one entry (no accumulation)', () => {
    const p = loadProfileTemplate('default')
    render(p)
    expect(gateEntries(render(p))).toHaveLength(1)
  })

  it('the rendered command is the fail-closed python form on the install\'s own script', () => {
    const [entry] = gateEntries(render(loadProfileTemplate('default')))
    const expected = pythonHookCommand(join(PROJECT_ROOT, 'scripts', 'hooks', 'device-keys-gate.py'))
    expect(entry.hooks[0].command).toBe(expected)
    expect(entry.hooks[0].command).toContain(GATE_FAIL_CLOSED_TAG)
  })

  it('the pre-existing gates are still there next to it', () => {
    const json = JSON.stringify(render(loadProfileTemplate('default')))
    for (const g of ['email-send-gate.mjs', 'self-pace-gate.mjs', 'egress-gate.mjs', 'bash-egress-parser.mjs']) {
      expect(json).toContain(g)
    }
  })
})

describe('the boot migration for the EXISTING fleet', () => {
  function strip(mutate?: (ptu: Ptu) => Ptu): string {
    render(loadProfileTemplate('default'))
    const path = agentSettingsPath(TEST_AGENT)
    const s = JSON.parse(readFileSync(path, 'utf-8')) as { hooks: { PreToolUse: Ptu } }
    s.hooks.PreToolUse = mutate
      ? mutate(s.hooks.PreToolUse)
      : s.hooks.PreToolUse.filter((e) => !JSON.stringify(e).includes(DEVICE_KEYS_GATE_SCRIPT))
    writeFileSync(path, JSON.stringify(s, null, 2))
    return path
  }

  it('adds the gate to a sub-agent scaffolded before this change', () => {
    const path = strip()
    expect(readFileSync(path, 'utf-8')).not.toContain(DEVICE_KEYS_GATE_SCRIPT)
    expect(ensureGovernanceGateCommands(TEST_AGENT)).toBe(true)
    const ptu = (JSON.parse(readFileSync(path, 'utf-8')) as { hooks: { PreToolUse: Ptu } }).hooks.PreToolUse
    expect(gateEntries(ptu)).toHaveLength(1)
  })

  it('is a no-op on an already-wired agent (no rewrite churn at every boot)', () => {
    render(loadProfileTemplate('default'))
    expect(ensureGovernanceGateCommands(TEST_AGENT)).toBe(false)
  })

  it('replaces a stale matcher instead of leaving a gate that never fires on the file tools', () => {
    const path = strip((ptu) => ptu.map((e) => (JSON.stringify(e).includes(DEVICE_KEYS_GATE_SCRIPT) ? { ...e, matcher: 'Bash' } : e)))
    expect(ensureGovernanceGateCommands(TEST_AGENT)).toBe(true)
    const entries = gateEntries((JSON.parse(readFileSync(path, 'utf-8')) as { hooks: { PreToolUse: Ptu } }).hooks.PreToolUse)
    expect(entries).toHaveLength(1)
    expect(entries[0].matcher).toBe(DEVICE_KEYS_GATE_MATCHER)
  })

  it('never touches the main agent\'s live settings (returns before reading them)', () => {
    expect(ensureGovernanceGateCommands(MAIN_AGENT_ID)).toBe(false)
  })
})

describe('the main agent: the repo-shipped project settings', () => {
  const settings = JSON.parse(readFileSync(join(PROJECT_ROOT, '.claude', 'settings.json'), 'utf-8')) as {
    hooks: { PreToolUse: Ptu }
  }
  const entries = gateEntries(settings.hooks.PreToolUse)

  it('carries exactly one entry, on the same matcher the sub-agents get', () => {
    expect(entries).toHaveLength(1)
    expect(entries[0].matcher).toBe(DEVICE_KEYS_GATE_MATCHER)
  })

  it('is the portable, fail-closed form of its sibling gates', () => {
    const cmd = entries[0].hooks[0].command
    expect(cmd).toContain('$CLAUDE_PROJECT_DIR/scripts/hooks/device-keys-gate.py')
    expect(cmd).toContain(GATE_FAIL_CLOSED_TAG)
    expect(cmd.endsWith('exit "$rc"')).toBe(true)
    expect(cmd).not.toMatch(/\/(Users|home|opt|var)\//)
  })
})

describe('the matcher', () => {
  it('fires on Bash and every file-writing tool, not on reads or the web', () => {
    const s: Record<string, unknown> = {}
    injectDeviceKeysGate(s)
    injectDeviceKeysGate(s)
    const ptu = (s.hooks as Record<string, unknown>).PreToolUse as Ptu
    expect(ptu).toHaveLength(1)
    const re = new RegExp(`^(?:${ptu[0].matcher})$`)
    for (const t of ['Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit']) expect(re.test(t)).toBe(true)
    for (const t of ['Read', 'WebFetch', 'Grep']) expect(re.test(t)).toBe(false)
  })
})
