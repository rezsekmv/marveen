// The install-local launchctl kickstart exception (scripts/self-pace-local-exceptions.mjs).
// A named agent may restart one of the owner's own launchd services with
//   launchctl kickstart [-k] gui/<uid>/<prefix><rest>
// and nothing else: every other launchctl form, agent, domain, uid, label or shell shape
// stays denied exactly as before, and the exception never lifts a deny for another reason.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision } from '../../scripts/self-pace-gate.mjs'
// @ts-expect-error -- plain .mjs hook script, no types
import { launchctlKickstartExempt, kickstartPrefixesFor } from '../../scripts/self-pace-local-exceptions.mjs'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, copyFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

const UID = process.getuid!()
const AGENT = 'ops-agent'
const CONFIG = { launchctlKickstart: { [AGENT]: ['zz.fleet.'] } }

let root: string
let store: string
let cfgPath: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kickstart-exc-'))
  store = join(root, 'store')
  mkdirSync(store)
  cfgPath = join(store, 'self-pace-exceptions.json')
  writeFileSync(cfgPath, JSON.stringify(CONFIG))
})
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

const decideAs = (command: string, selfAgent: string | undefined, exceptionsPath = cfgPath) =>
  gateDecision('Bash', { command }, {
    selfAgent, exceptionsPath, storeDir: store, allowlistPath: join(store, 'egress-allowlist.json'), cwd: root,
  })
const decide = (command: string) => decideAs(command, AGENT)

// Shapes the gate itself has never denied (pre-existing gaps of the scheduler regex, not
// part of this change). For them the test pins only what this change owns: the exception
// does not fire, and the verdict is exactly the no-config verdict.
const PRE_EXISTING_GAPS = new Set([
  `{ launchctl kickstart -k gui/${UID}/zz.fleet.dashboard; }`,
  `'launchctl' kickstart -k gui/${UID}/zz.fleet.dashboard`,
  `launchctl kick\\start -k gui/${UID}/zz.fleet.dashboard`,
])
// The exception does not fire, the verdict equals the verdict with no config at all, and
// (outside the pre-existing gaps) that verdict is a deny.
const stillDenied = (command: string) => {
  expect(launchctlKickstartExempt(command, { selfAgent: AGENT, exceptionsPath: cfgPath })).toBe(false)
  const verdict = decide(command)
  expect(verdict).toEqual(decideAs(command, AGENT, join(root, 'no-config.json')))
  if (!PRE_EXISTING_GAPS.has(command)) expect(verdict.deny).toBe(true)
}

describe('allowed forms', () => {
  it.each([
    `launchctl kickstart gui/${UID}/zz.fleet.dashboard`,
    `launchctl kickstart -k gui/${UID}/zz.fleet.dashboard`,
    `/bin/launchctl kickstart -k gui/${UID}/zz.fleet.dashboard`,
    `/bin/launchctl kickstart gui/${UID}/zz.fleet.voice-front.v2`,
    `launchctl  kickstart  -k  gui/${UID}/zz.fleet.a`,
    ` launchctl kickstart -k gui/${UID}/zz.fleet.0x `,
  ])('allows: %s', (command) => {
    expect(decide(command)).toEqual({ deny: false })
  })

  it('a second configured prefix works too', () => {
    writeFileSync(cfgPath, JSON.stringify({ launchctlKickstart: { [AGENT]: ['zz.fleet.', 'com.acme-ops.'] } }))
    expect(decide(`launchctl kickstart -k gui/${UID}/com.acme-ops.web`).deny).toBe(false)
  })
})

describe('everything else stays denied', () => {
  const T = `gui/${UID}/zz.fleet.dashboard`

  it('POSITIVE CONTROL: without the exception the same command is denied', () => {
    expect(decideAs(`launchctl kickstart -k ${T}`, AGENT, join(root, 'none.json')).deny).toBe(true)
  })

  it.each([
    ['another agent', 'other-agent'],
    ['no agent (main / unknown project dir)', undefined],
    ['a prototype key', 'constructor'],
    ['a prototype key', '__proto__'],
  ])('%s: %s', (_why, agent) => {
    expect(decideAs(`launchctl kickstart -k ${T}`, agent as string | undefined).deny).toBe(true)
  })

  it.each([
    'load', 'unload', 'bootstrap', 'bootout', 'submit', 'enable', 'disable', 'start', 'stop',
    'kill', 'remove', 'setenv', 'unsetenv', 'asuser', 'config', 'reboot',
  ])('other subcommand: launchctl %s', (sub) => {
    expect(decide(`launchctl ${sub} ${T}`).deny).toBe(true)
  })

  it.each([
    `launchctl kickstart -p ${T}`,
    `launchctl kickstart -s ${T}`,
    `launchctl kickstart -kp ${T}`,
    `launchctl kickstart -k -p ${T}`,
    `launchctl kickstart -p -k ${T}`,
    `launchctl kickstart -k -k ${T}`,
    `launchctl kickstart --k ${T}`,
    `launchctl kickstart ${T} -k`,
    `launchctl kickstart ${T} ${T}`,
    `launchctl kickstart`,
    `launchctl kickstart -k`,
    `launchctl -k kickstart ${T}`,
  ])('other flags / argument shapes: %s', (command) => {
    stillDenied(command)
  })

  it.each([
    `launchctl kickstart -k system/zz.fleet.dashboard`,
    `launchctl kickstart -k user/${UID}/zz.fleet.dashboard`,
    `launchctl kickstart -k gui/${UID}`,
    `launchctl kickstart -k gui//zz.fleet.dashboard`,
    `launchctl kickstart -k login/${UID}/zz.fleet.dashboard`,
    `launchctl kickstart -k pid/1/zz.fleet.dashboard`,
    `launchctl kickstart -k gui/${UID}/../system/zz.fleet.dashboard`,
  ])('other domains: %s', (command) => {
    stillDenied(command)
  })

  it.each([
    `launchctl kickstart -k gui/${UID + 1}/zz.fleet.dashboard`,
    `launchctl kickstart -k gui/0/zz.fleet.dashboard`,
    `launchctl kickstart -k gui/0${UID}/zz.fleet.dashboard`,
    `launchctl kickstart -k gui/${UID}0/zz.fleet.dashboard`,
  ])('wrong uid: %s', (command) => {
    stillDenied(command)
  })

  it.each([
    'com.apple.Finder',
    'com.fleet.dashboard',
    'zz.fleet',
    'zz.fleet.',
    'zz.fleet-evil',
    'zz.fleet-evil.x',
    'hu.fleetx.dashboard',
    'hu.fleetX.dashboard',
    'zz.fleet..x',
    'zz.fleet.-x',
    'zz.fleet.Dashboard',
    'zz.fleet.dash_board',
    'xhu.fleet.dashboard',
    'ZZ.FLEET.dashboard',
  ])('label not under the prefix: %s', (label) => {
    stillDenied(`launchctl kickstart -k gui/${UID}/${label}`)
  })

  it.each([
    `launchctl kickstart -k ${T}; crontab -r`,
    `launchctl kickstart -k ${T};launchctl load x.plist`,
    `launchctl kickstart -k ${T} && launchctl bootout gui/${UID}`,
    `launchctl kickstart -k ${T} || launchctl submit -l x -- sh`,
    `launchctl kickstart -k ${T} | sh`,
    `launchctl kickstart -k ${T} & launchctl load x.plist`,
    `launchctl kickstart -k ${T} &`,
    `launchctl kickstart -k ${T}\nlaunchctl load x.plist`,
    `launchctl kickstart -k ${T}\n`,
    `echo hi; launchctl kickstart -k ${T}`,
    `launchctl kickstart -k ${T}\\\n`,
  ])('chaining: %j', (command) => {
    stillDenied(command)
  })

  it.each([
    `launchctl kickstart -k gui/$(id -u)/zz.fleet.dashboard`,
    `launchctl kickstart -k gui/\`id -u\`/zz.fleet.dashboard`,
    `launchctl kickstart -k gui/$UID/zz.fleet.dashboard`,
    `launchctl kickstart -k gui/\${UID}/zz.fleet.dashboard`,
    `launchctl kickstart -k ${T}$(crontab -r)`,
    `X=$(launchctl kickstart -k ${T})`,
    `(launchctl kickstart -k ${T})`,
    `{ launchctl kickstart -k ${T}; }`,
  ])('command substitution / grouping: %s', (command) => {
    stillDenied(command)
  })

  it.each([
    `launchctl kickstart -k ${T} > /tmp/x`,
    `launchctl kickstart -k ${T} 2>&1`,
    `launchctl kickstart -k ${T} < /dev/null`,
    `launchctl kickstart -k ${T} >> /tmp/x`,
  ])('redirects: %s', (command) => {
    stillDenied(command)
  })

  it.each([
    `launchctl kickstart -k '${T}'`,
    `launchctl kickstart -k "${T}"`,
    `'launchctl' kickstart -k ${T}`,
    `launchctl "kickstart" -k ${T}`,
    `launchctl kickstart -k gui/${UID}/zz.fleet.dash\\board`,
    `launchctl kick\\start -k ${T}`,
    `launchctl kickstart -k gui/${UID}/zz.fleet.*`,
    `launchctl kickstart -k gui/${UID}/zz.fleet.dash?`,
    `launchctl kickstart -k gui/${UID}/zz.fleet.[a]`,
    `launchctl kickstart -k gui/${UID}/zz.fleet.{a,b}`,
    `launchctl kickstart -k ~/zz.fleet.dashboard`,
    `launchctl\tkickstart -k ${T}`,
  ])('quotes / escapes / globbing: %s', (command) => {
    stillDenied(command)
  })

  it.each([
    `sudo launchctl kickstart -k ${T}`,
    `env launchctl kickstart -k ${T}`,
    `FOO=1 launchctl kickstart -k ${T}`,
    `command launchctl kickstart -k ${T}`,
    `exec launchctl kickstart -k ${T}`,
    `nice launchctl kickstart -k ${T}`,
    `time launchctl kickstart -k ${T}`,
    `/usr/bin/launchctl kickstart -k ${T}`,
    `./launchctl kickstart -k ${T}`,
    `/tmp/bin/launchctl kickstart -k ${T}`,
    `bin/launchctl kickstart -k ${T}`,
    `//bin/launchctl kickstart -k ${T}`,
  ])('prefixes / other binaries: %s', (command) => {
    stillDenied(command)
  })
})

describe('the config fails closed', () => {
  const CMD = `launchctl kickstart -k gui/${UID}/zz.fleet.dashboard`

  it('a missing file grants nothing', () => {
    expect(decideAs(CMD, AGENT, join(store, 'missing.json')).deny).toBe(true)
  })
  it.each([
    ['malformed JSON', '{"launchctlKickstart": {'],
    ['empty file', ''],
    ['null', 'null'],
    ['an array', '[]'],
    ['no launchctlKickstart key', '{}'],
    ['launchctlKickstart is an array', JSON.stringify({ launchctlKickstart: [AGENT] })],
    ['launchctlKickstart is a string', JSON.stringify({ launchctlKickstart: AGENT })],
    ['the agent maps to a string', JSON.stringify({ launchctlKickstart: { [AGENT]: 'zz.fleet.' } })],
    ['the agent maps to true', JSON.stringify({ launchctlKickstart: { [AGENT]: true } })],
    ['the agent maps to an empty list', JSON.stringify({ launchctlKickstart: { [AGENT]: [] } })],
    ['a wildcard agent', JSON.stringify({ launchctlKickstart: { '*': ['zz.fleet.'] } })],
  ])('%s grants nothing', (_why, content) => {
    writeFileSync(cfgPath, content)
    expect(decide(CMD).deny).toBe(true)
  })

  it.each([
    ['no trailing dot', 'zz.fleet'],
    ['empty string', ''],
    ['a lone dot', '.'],
    ['leading dot', '.zz.fleet.'],
    ['double dot', 'hu..fleet.'],
    ['uppercase', 'HU.fleet.'],
    ['a glob', 'hu.*.'],
    ['a slash', 'gui/501/zz.fleet.'],
    ['a space', 'hu. fleet.'],
    ['a number', 7],
    ['null', null],
    ['an object', { p: 'zz.fleet.' }],
  ])('an invalid prefix entry (%s) is ignored', (_why, entry) => {
    writeFileSync(cfgPath, JSON.stringify({ launchctlKickstart: { [AGENT]: [entry] } }))
    expect(kickstartPrefixesFor(AGENT, cfgPath)).toEqual([])
    expect(decide(CMD).deny).toBe(true)
  })

  it.each(['hu.', 'com.', 'a.', 'fleet.'])('a single-component prefix (%s) is ignored', (entry) => {
    writeFileSync(cfgPath, JSON.stringify({ launchctlKickstart: { [AGENT]: [entry] } }))
    expect(kickstartPrefixesFor(AGENT, cfgPath)).toEqual([])
    expect(decide(CMD).deny).toBe(true)
  })

  it.each(['zz.fleet.', 'com.acme-ops.', 'a.b.', 'zz.fleet.ops.'])('a prefix of two or more components (%s) is accepted', (entry) => {
    writeFileSync(cfgPath, JSON.stringify({ launchctlKickstart: { [AGENT]: [entry] } }))
    expect(kickstartPrefixesFor(AGENT, cfgPath)).toEqual([entry])
  })

  it('a valid entry next to invalid ones still works, and only it', () => {
    writeFileSync(cfgPath, JSON.stringify({ launchctlKickstart: { [AGENT]: ['zz.fleet', 7, 'zz.fleet.', '.'] } }))
    expect(kickstartPrefixesFor(AGENT, cfgPath)).toEqual(['zz.fleet.'])
    expect(decide(CMD).deny).toBe(false)
  })

  it('a symlinked config is not followed', () => {
    const real = join(root, 'real.json')
    writeFileSync(real, JSON.stringify(CONFIG))
    const link = join(store, 'linked.json')
    symlinkSync(real, link)
    expect(decideAs(CMD, AGENT, link).deny).toBe(true)
    expect(decideAs(CMD, AGENT, real).deny).toBe(false) // control
  })

  it('a directory at the config path grants nothing', () => {
    const dir = join(store, 'dir.json')
    mkdirSync(dir)
    expect(decideAs(CMD, AGENT, dir).deny).toBe(true)
  })

  it('the pure check refuses non-string input', () => {
    expect(launchctlKickstartExempt(undefined, { selfAgent: AGENT, exceptionsPath: cfgPath })).toBe(false)
    expect(launchctlKickstartExempt(['launchctl'], { selfAgent: AGENT, exceptionsPath: cfgPath })).toBe(false)
    expect(launchctlKickstartExempt(CMD, { selfAgent: AGENT, exceptionsPath: cfgPath })).toBe(true)
  })
})

describe('the exception never lifts another deny', () => {
  it('only Bash is affected: the self-pace tools stay denied for the agent', () => {
    for (const t of ['ScheduleWakeup', 'CronCreate', 'RemoteTrigger']) {
      expect(gateDecision(t, {}, { selfAgent: AGENT, exceptionsPath: cfgPath }).deny).toBe(true)
    }
  })
})

describe('the config file is a protected store file', () => {
  const DENY = { deny: true, reason: 'protected-store-file' }
  it.each(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])('%s on it is denied, also for the granted agent', (tool) => {
    expect(gateDecision(tool, { file_path: cfgPath, content: '{}' }, { selfAgent: AGENT, exceptionsPath: cfgPath, storeDir: store, cwd: root })).toEqual(DENY)
    expect(gateDecision(tool, { file_path: 'store/self-pace-exceptions.json', content: '{}' }, { selfAgent: AGENT, storeDir: store, cwd: root })).toEqual(DENY)
  })
  it.each([
    `echo '{}' > store/self-pace-exceptions.json`,
    `echo x >> store/self-pace-exceptions.json`,
    `cp /tmp/x.json store/self-pace-exceptions.json`,
    `mv /tmp/x.json store/self-pace-exceptions.json`,
    `rm store/self-pace-exceptions.json`,
    `ln -sf /tmp/x store/self-pace-exceptions.json`,
    `sed -i '' 's/a/b/' store/self-pace-exceptions.json`,
    `tee store/self-pace-exceptions.json < /tmp/x`,
    `python3 -c "open('store/self-pace-exceptions.json','w').write('{}')"`,
    `cp /tmp/x store/self-pace-exc*`,
  ])('Bash write is denied: %s', (command) => {
    expect(decide(command)).toEqual(DENY)
  })
  it.each([
    'cat store/self-pace-exceptions.json',
    'jq . store/self-pace-exceptions.json',
    'grep ops store/self-pace-exceptions.json',
  ])('a read is allowed: %s', (command) => {
    expect(decide(command).deny).toBe(false)
  })
  it.each([
    'npx vitest run src/__tests__/self-pace-kickstart-exception.test.ts',
    'git add scripts/self-pace-local-exceptions.mjs scripts/self-pace-gate.mjs',
    'git diff -- scripts/self-pace*',
  ])('the feature sources are not the store file: %s', (command) => {
    expect(decide(command).deny).toBe(false)
  })
})

describe('the hook end to end (deny paths and the no-config default only)', () => {
  const hook = join(__dirname, '..', '..', 'scripts', 'self-pace-gate.mjs')
  const run = (command: string, agent: string) =>
    spawnSync(process.execPath, [hook], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: root }),
      encoding: 'utf-8',
      env: { ...process.env, CLAUDE_PROJECT_DIR: join(root, 'agents', agent) },
    })
  const denied = (r: ReturnType<typeof run>) => JSON.parse(r.stdout).hookSpecificOutput.permissionDecision === 'deny'

  it('another launchctl write is denied through the hook', () => {
    expect(denied(run(`launchctl load ~/Library/LaunchAgents/x.plist`, AGENT))).toBe(true)
  })
  it('a chained kickstart is denied through the hook', () => {
    expect(denied(run(`launchctl kickstart -k gui/${UID}/zz.fleet.dashboard; crontab -r`, AGENT))).toBe(true)
  })
  it('an agent the hook cannot map to this install is denied (no config applies)', () => {
    // CLAUDE_PROJECT_DIR is outside the gate's own install root, so selfAgent is undefined
    expect(denied(run(`launchctl kickstart -k gui/${UID}/zz.fleet.dashboard`, AGENT))).toBe(true)
  })
  it('an agent of this install with no grant in the fixed store config is denied (the temp config is never read)', () => {
    const r = spawnSync(process.execPath, [hook], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: `launchctl kickstart -k gui/${UID}/zz.fleet.dashboard` }, cwd: root }),
      encoding: 'utf-8',
      env: { ...process.env, CLAUDE_PROJECT_DIR: join(__dirname, '..', '..', 'agents', 'kickstart-test-no-such-agent') },
    })
    expect(denied(r)).toBe(true)
  })
})

// The gate loads the exceptions module DEFENSIVELY. A static import of a missing or broken
// module would crash the hook with exit 1, which PreToolUse treats as non-blocking (FAIL
// OPEN), and the gates that import this one (kanban-write-gate, bash-egress-parser) would
// crash with it. A missing or broken module must mean "no exception", never "no gate".
describe('a missing or broken exceptions module never opens the gate', () => {
  const realScripts = join(__dirname, '..', '..', 'scripts')
  let install: string
  let hook: string
  beforeEach(() => {
    install = realpathSync(mkdtempSync(join(tmpdir(), 'kickstart-nomod-')))
    for (const d of ['scripts', 'store', `agents/${AGENT}`]) mkdirSync(join(install, d), { recursive: true })
    copyFileSync(join(realScripts, 'self-pace-gate.mjs'), join(install, 'scripts', 'self-pace-gate.mjs'))
    // a grant that WOULD allow the kickstart if the module were loaded
    writeFileSync(join(install, 'store', 'self-pace-exceptions.json'), JSON.stringify(CONFIG))
    hook = join(install, 'scripts', 'self-pace-gate.mjs')
  })
  afterEach(() => { rmSync(install, { recursive: true, force: true }) })

  const KICK = `launchctl kickstart -k gui/${UID}/zz.fleet.dashboard`
  const run = (command: string) => spawnSync(process.execPath, [hook], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: install }),
    encoding: 'utf-8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: join(install, 'agents', AGENT) },
  })
  const expectDeny = (r: ReturnType<typeof run>) => {
    expect(r.status).toBe(0)
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe('deny')
  }
  const expectAllow = (r: ReturnType<typeof run>) => {
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('')
  }
  const modPath = () => join(install, 'scripts', 'self-pace-local-exceptions.mjs')

  it('POSITIVE CONTROL: with the real module next to it, the grant allows the kickstart', () => {
    copyFileSync(join(realScripts, 'self-pace-local-exceptions.mjs'), modPath())
    expectAllow(run(KICK))
    expectDeny(run('crontab -r'))
  })

  const variants: Array<[string, () => void]> = [
    ['missing', () => {}],
    ['syntax-broken', () => writeFileSync(modPath(), 'export function launchctlKickstartExempt( {\n')],
    ['throwing at load', () => writeFileSync(modPath(), "throw new Error('boom')\n")],
    ['exporting a non-function', () => writeFileSync(modPath(), 'export const launchctlKickstartExempt = true\n')],
    ['a directory', () => mkdirSync(modPath())],
  ]
  for (const [why, setup] of variants) {
    describe(`module ${why}`, () => {
      beforeEach(() => setup())
      it('crontab -r is still denied (exit 0 + deny JSON)', () => expectDeny(run('crontab -r')))
      it('the granted kickstart is denied (no exception)', () => expectDeny(run(KICK)))
      it('a protected store write is still denied', () => expectDeny(run('echo x > store/self-pace-exceptions.json')))
      it('a harmless command still passes', () => expectAllow(run('ls -la')))
      it('a static importer of the gate still loads it', () => {
        const r = spawnSync(process.execPath, ['--input-type=module', '-e',
          `const m = await import(${JSON.stringify(hook)}); console.log(typeof m.splitSegments, typeof m.maskInertLiterals)`], { encoding: 'utf-8' })
        expect(r.status).toBe(0)
        expect(r.stdout.trim()).toBe('function function')
      })
    })
  }

  // Defense in depth: the gate checks the kickstart shape itself, so a module that says
  // "exempt" for everything still cannot exempt any other command.
  describe('a replaced module that returns true for everything', () => {
    beforeEach(() => writeFileSync(modPath(), 'export function launchctlKickstartExempt() { return true }\n'))
    it.each([
      'crontab -r',
      'launchctl load ~/Library/LaunchAgents/x.plist',
      `launchctl bootout gui/${UID}/zz.fleet.dashboard`,
      `launchctl kickstart -p gui/${UID}/zz.fleet.dashboard`,
      `launchctl kickstart -k system/zz.fleet.dashboard`,
      `launchctl kickstart -k gui/${UID}/zz.fleet.dashboard; crontab -r`,
      `sudo launchctl kickstart -k gui/${UID}/zz.fleet.dashboard`,
      'launchctl submit -l x -- sh',
      'at now',
    ])('still denies: %s', (command) => expectDeny(run(command)))
    it('only the strict kickstart shape reaches it (it then decides, here: allow)', () => expectAllow(run(KICK)))
  })
})
