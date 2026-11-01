// QA (black box, from the spec): the narrow `launchctl kickstart` exception in the self-pace gate.
// The ops agent `opsbot` may restart the owner's `zz.fleet.*` launchd services himself; everything
// else about launchctl stays denied. Config: store/self-pace-exceptions.json (fail closed, protected).
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision } from '../../scripts/self-pace-gate.mjs'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, copyFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

const UID = process.getuid!()
const GOOD_CONFIG = { launchctlKickstart: { opsbot: ['zz.fleet.'] } }
const LABEL = 'zz.fleet.marveen'
const TARGET = `gui/${UID}/${LABEL}`

let root: string
let store: string
let cfg: string
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'kickstart-qa-')))
  store = join(root, 'store')
  mkdirSync(store)
  cfg = join(root, 'exceptions.json')
  writeFileSync(cfg, JSON.stringify(GOOD_CONFIG))
})
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

const decide = (command: string, selfAgent = 'opsbot', exceptionsPath = cfg) =>
  gateDecision('Bash', { command }, {
    selfAgent, exceptionsPath, storeDir: store, allowlistPath: join(store, 'egress-allowlist.json'), cwd: root,
  })
const allowed = (command: string, selfAgent = 'opsbot', p = cfg) => expect(decide(command, selfAgent, p).deny).toBe(false)
const denied = (command: string, selfAgent = 'opsbot', p = cfg) => expect(decide(command, selfAgent, p).deny).toBe(true)

describe('an allowed kickstart by the listed agent', () => {
  it.each([
    `launchctl kickstart ${TARGET}`,
    `launchctl kickstart -k ${TARGET}`,
    `/bin/launchctl kickstart ${TARGET}`,
    `/bin/launchctl kickstart -k ${TARGET}`,
    `launchctl kickstart -k gui/${UID}/zz.fleet.a-b.c9`,
    `launchctl kickstart gui/${UID}/zz.fleet.0abc`,
  ])('passes: %s', (command) => { allowed(command) })

  it('a second configured prefix works too', () => {
    writeFileSync(cfg, JSON.stringify({ launchctlKickstart: { opsbot: ['zz.fleet.', 'com.example.'] } }))
    allowed(`launchctl kickstart gui/${UID}/com.example.svc`)
    allowed(`launchctl kickstart gui/${UID}/zz.fleet.svc`)
  })
})

describe('only the listed agent', () => {
  it.each(['devbot', 'uibot', 'mainbot', 'opsbotx', 'OPSBOT', ''])('agent %j is denied', (agent) => {
    denied(`launchctl kickstart ${TARGET}`, agent)
    denied(`launchctl kickstart -k ${TARGET}`, agent)
  })
  it('an agent that is not listed under launchctlKickstart is denied even when another is listed', () => {
    writeFileSync(cfg, JSON.stringify({ launchctlKickstart: { devbot: ['zz.fleet.'] } }))
    denied(`launchctl kickstart ${TARGET}`, 'opsbot')
    allowed(`launchctl kickstart ${TARGET}`, 'devbot')
  })
})

describe('other launchctl subcommands stay denied', () => {
  it.each([
    `load ~/Library/LaunchAgents/${LABEL}.plist`,
    `unload ~/Library/LaunchAgents/${LABEL}.plist`,
    `bootstrap gui/${UID} ~/Library/LaunchAgents/${LABEL}.plist`,
    `bootout gui/${UID}/${LABEL}`,
    `submit -l x -- /bin/true`,
    `enable gui/${UID}/${LABEL}`,
    `disable gui/${UID}/${LABEL}`,
    `start ${LABEL}`,
    `stop ${LABEL}`,
    `kill SIGKILL gui/${UID}/${LABEL}`,
    `kill 9 gui/${UID}/${LABEL}`,
    `remove ${LABEL}`,
    `setenv FOO bar`,
  ])('denies: launchctl %s', (rest) => {
    denied(`launchctl ${rest}`)
    denied(`/bin/launchctl ${rest}`)
  })
})

describe('kickstart outside the exact form stays denied', () => {
  it.each([
    [`flag -p`, `launchctl kickstart -p ${TARGET}`],
    [`flag -s`, `launchctl kickstart -s ${TARGET}`],
    [`flags -k -p`, `launchctl kickstart -k -p ${TARGET}`],
    [`flags -kp`, `launchctl kickstart -kp ${TARGET}`],
    [`flags -ks`, `launchctl kickstart -ks ${TARGET}`],
    [`two targets`, `launchctl kickstart ${TARGET} gui/${UID}/zz.fleet.other`],
    [`no target`, `launchctl kickstart`],
    [`-k no target`, `launchctl kickstart -k`],
    [`system domain`, `launchctl kickstart system/${LABEL}`],
    [`system domain with -k`, `launchctl kickstart -k system/${LABEL}`],
    [`user domain`, `launchctl kickstart user/${UID}/${LABEL}`],
    [`bare label`, `launchctl kickstart ${LABEL}`],
    [`gui domain without label`, `launchctl kickstart gui/${UID}`],
    [`gui domain without label, trailing slash`, `launchctl kickstart gui/${UID}/`],
    [`other uid`, `launchctl kickstart gui/${UID + 1}/${LABEL}`],
    [`uid 0`, `launchctl kickstart gui/0/${LABEL}`],
    [`non-numeric uid`, `launchctl kickstart gui/opsbot/${LABEL}`],
    [`label outside the prefix`, `launchctl kickstart gui/${UID}/com.apple.Dock.agent`],
    [`label zz.fleet-evil.x`, `launchctl kickstart gui/${UID}/zz.fleet-evil.x`],
    [`label hu.fleetx.y`, `launchctl kickstart gui/${UID}/hu.fleetx.y`],
    [`label com.zz.fleet.x`, `launchctl kickstart gui/${UID}/com.zz.fleet.x`],
    [`label ZZ.FLEET.x`, `launchctl kickstart gui/${UID}/ZZ.FLEET.x`],
    [`label with empty remainder`, `launchctl kickstart gui/${UID}/zz.fleet.`],
    [`label remainder starts with dash`, `launchctl kickstart gui/${UID}/zz.fleet.-x`],
    [`label remainder starts with dot`, `launchctl kickstart gui/${UID}/zz.fleet..x`],
    [`label remainder uppercase`, `launchctl kickstart gui/${UID}/zz.fleet.Marveen`],
    [`label remainder underscore`, `launchctl kickstart gui/${UID}/zz.fleet.a_b`],
    [`label with path traversal`, `launchctl kickstart gui/${UID}/zz.fleet.x/../../com.apple.y`],
    [`label with a slash`, `launchctl kickstart gui/${UID}/zz.fleet.x/y`],
    [`label with a glob`, `launchctl kickstart gui/${UID}/zz.fleet.*`],
    [`label with a variable`, `launchctl kickstart gui/${UID}/zz.fleet.$X`],
    [`uid via variable`, `launchctl kickstart gui/$UID/${LABEL}`],
    [`uid via id -u substitution`, `launchctl kickstart gui/$(id -u)/${LABEL}`],
  ])('denies: %s', (_n, command) => { denied(command) })
})

// Wrappers the gate does not parse today (nohup, xargs, bash -c, eval, braces, quoted binary) are
// outside this change: "everything else keeps today's behaviour", so they are not asserted here.
describe('chaining, substitution, redirects, quoting and prefixes stay denied', () => {
  const K = `launchctl kickstart -k ${TARGET}`
  it.each([
    [`;`, `${K}; echo hi`],
    [`; before`, `echo hi; ${K}`],
    [`&&`, `${K} && echo hi`],
    [`&& before`, `true && ${K}`],
    [`||`, `${K} || echo hi`],
    [`|`, `${K} | cat`],
    [`| before`, `echo x | ${K}`],
    [`& background`, `${K} &`],
    [`& chain`, `${K} & echo hi`],
    [`newline`, `${K}\necho hi`],
    [`newline before`, `echo hi\n${K}`],
    [`$() after`, `${K} $(echo x)`],
    [`$() in label`, `launchctl kickstart gui/${UID}/zz.fleet.$(echo x)`],
    [`$() wrapping`, `echo $(${K})`],
    [`backticks`, `${K} \`echo x\``],
    [`backticks wrapping`, `echo \`${K}\``],
    [`stdout redirect`, `${K} > /tmp/out`],
    [`append redirect`, `${K} >> /tmp/out`],
    [`stderr redirect`, `${K} 2>&1`],
    [`stdin redirect`, `${K} < /dev/null`],
    [`heredoc`, `${K} <<EOF\nx\nEOF`],
    [`double-quoted target`, `launchctl kickstart -k "${TARGET}"`],
    [`single-quoted target`, `launchctl kickstart -k '${TARGET}'`],
    [`quoted subcommand`, `launchctl "kickstart" -k ${TARGET}`],
    [`sudo`, `sudo ${K}`],
    [`env prefix`, `env FOO=1 ${K}`],
    [`assignment prefix`, `FOO=1 ${K}`],
    [`DYLD assignment prefix`, `DYLD_INSERT_LIBRARIES=/tmp/x.dylib ${K}`],
    [`command prefix`, `command ${K}`],
    [`exec prefix`, `exec ${K}`],
    [`time prefix`, `time ${K}`],
    [`subshell`, `(${K})`],
    [`relative path launchctl`, `./launchctl kickstart -k ${TARGET}`],
    [`other path launchctl`, `/tmp/launchctl kickstart -k ${TARGET}`],
  ])('denies: %s', (_n, command) => { denied(command) })
})

describe('the config fails closed', () => {
  const cases: Array<[string, string | null]> = [
    ['missing file', null],
    ['empty file', ''],
    ['malformed JSON', '{not json'],
    ['truncated JSON', '{"launchctlKickstart":{"opsbot":["zz.fleet."'],
    ['array at top level', '[]'],
    ['null at top level', 'null'],
    ['a string at top level', '"x"'],
    ['empty object', '{}'],
    ['launchctlKickstart is a string', '{"launchctlKickstart":"opsbot"}'],
    ['launchctlKickstart is an array', '{"launchctlKickstart":["opsbot"]}'],
    ['agent value is a string, not a list', '{"launchctlKickstart":{"opsbot":"zz.fleet."}}'],
    ['agent value is an object', '{"launchctlKickstart":{"opsbot":{"0":"zz.fleet."}}}'],
    ['agent value is an empty list', '{"launchctlKickstart":{"opsbot":[]}}'],
  ]
  it.each(cases)('%s: no exception', (_n, body) => {
    const p = join(root, 'case.json')
    if (body !== null) writeFileSync(p, body)
    denied(`launchctl kickstart ${TARGET}`, 'opsbot', p)
    denied(`launchctl kickstart -k ${TARGET}`, 'opsbot', p)
  })
  it('a directory at the config path: no exception, no crash', () => {
    denied(`launchctl kickstart ${TARGET}`, 'opsbot', root)
  })
  it('an unrelated allowed command stays allowed with a malformed config (no crash)', () => {
    writeFileSync(cfg, '{not json')
    allowed('ls -la')
    allowed('git status')
  })
  it('an unrelated allowed command stays allowed with a missing config', () => {
    allowed('ls -la', 'opsbot', join(root, 'nope.json'))
  })
})

describe('invalid prefix entries are ignored', () => {
  const withPrefixes = (list: unknown[]) => writeFileSync(cfg, JSON.stringify({ launchctlKickstart: { opsbot: list } }))
  it.each([
    ['no trailing dot', 'zz.fleet'],
    ['uppercase', 'ZZ.FLEET.'],
    ['underscore', 'hu_fleet.'],
    ['space', 'hu fleet.'],
    ['slash', 'hu/fleet.'],
    ['glob star', 'zz.fleet.*'],
    ['regex dot-star', 'hu.*.'],
    ['empty string', ''],
    ['path traversal', '../'],
    ['shell metacharacter', 'zz.fleet.;'],
  ])('%s: that entry grants nothing', (_n, entry) => {
    withPrefixes([entry])
    denied(`launchctl kickstart gui/${UID}/zz.fleet.marveen`)
    denied(`launchctl kickstart gui/${UID}/hu.fleetx.y`)
    denied(`launchctl kickstart gui/${UID}/${entry}x`)
  })
  it.each([null, 5, true, {}, ['zz.fleet.']])('a non-string entry %j grants nothing', (entry) => {
    withPrefixes([entry])
    denied(`launchctl kickstart ${TARGET}`)
  })
  it('an invalid entry does not poison a valid one next to it', () => {
    withPrefixes(['bad', 5, 'zz.fleet.'])
    allowed(`launchctl kickstart ${TARGET}`)
    denied(`launchctl kickstart gui/${UID}/bad`)
  })
  it('a prefix without a trailing dot cannot be bypassed by a sibling label', () => {
    withPrefixes(['zz.fleet'])
    denied(`launchctl kickstart gui/${UID}/hu.fleetx.y`)
  })
})

describe('the exception never turns another deny into an allow', () => {
  it('a protected store file mentioned in the same command stays denied', () => {
    writeFileSync(join(store, 'self-pace-exceptions.json'), '{}')
    denied(`launchctl kickstart ${TARGET} store/self-pace-exceptions.json`)
    denied(`launchctl kickstart ${TARGET} > store/self-pace-exceptions.json`)
    denied(`launchctl kickstart ${TARGET}; echo x > store/self-pace-exceptions.json`)
  })
})

describe('store/self-pace-exceptions.json is protected like the other gate files', () => {
  const F = 'self-pace-exceptions.json'
  const DENY = { deny: true, reason: 'protected-store-file' }
  const decideTool = (tool: string, input: Record<string, unknown>, agent = 'opsbot') =>
    gateDecision(tool, input, {
      selfAgent: agent, exceptionsPath: cfg, storeDir: store, allowlistPath: join(store, 'egress-allowlist.json'), cwd: root,
    })
  beforeEach(() => { writeFileSync(join(store, F), JSON.stringify(GOOD_CONFIG)) })

  it.each(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])('%s on the file is denied (absolute path)', (tool) => {
    expect(decideTool(tool, { file_path: join(store, F), content: '{}' })).toEqual(DENY)
  })
  it('a relative path is denied', () => {
    expect(decideTool('Edit', { file_path: `store/${F}` })).toEqual(DENY)
  })
  it('it is denied for opsbot, the very agent the file grants the exception to', () => {
    expect(decideTool('Write', { file_path: join(store, F), content: '{}' }, 'opsbot')).toEqual(DENY)
  })

  it.each([
    `echo '{}' > store/${F}`,
    `echo x >> store/${F}`,
    `cat new.json | tee store/${F}`,
    `cp /tmp/x.json store/${F}`,
    `mv /tmp/x.json store/${F}`,
    `mv store/${F} /tmp/x.json`,
    `rm store/${F}`,
    `rm -f store/${F}`,
    `sed -i '' 's/a/b/' store/${F}`,
    `sed -i 's/a/b/' store/${F}`,
    `ln -sf /tmp/x store/${F}`,
    `truncate -s 0 store/${F}`,
    `cd store && cp /tmp/x.json ${F}`,
    `python3 -c "import json;json.dump({},open('store/${F}','w'))"`,
    `node -e "require('fs').writeFileSync('store/${F}','{}')"`,
  ])('Bash write is denied: %s', (command) => {
    expect(decideTool('Bash', { command })).toEqual(DENY)
  })

  it.each([
    `cat store/${F}`,
    `jq . store/${F}`,
    `grep -c x store/${F}`,
    `ls -la store/${F}`,
    `diff store/${F} /tmp/copy.json`,
  ])('Bash read stays allowed: %s', (command) => {
    expect(decideTool('Bash', { command }).deny).toBe(false)
  })

  it('another file in store/ is not affected', () => {
    expect(decideTool('Write', { file_path: join(store, 'other.json'), content: '{}' }).deny).toBe(false)
  })
  it('a similar name is not the file', () => {
    expect(decideTool('Write', { file_path: join(root, 'self-pace-exceptions.example.json'), content: '{}' }).deny).toBe(false)
  })

  describe('the hook end to end: the message names the file', () => {
    const hook = join(__dirname, '..', '..', 'scripts', 'self-pace-gate.mjs')
    const run = (payload: unknown) =>
      spawnSync(process.execPath, [hook], { input: JSON.stringify(payload), encoding: 'utf-8' })
    it('a Write is denied with the protected-file message', () => {
      const r = run({ tool_name: 'Write', tool_input: { file_path: `/x/store/${F}`, content: '{}' }, cwd: root })
      const reason = JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason
      expect(reason).toContain(F)
      expect(reason).toContain('fo agenst')
    })
    it('a Bash redirect is denied with the same message', () => {
      const r = run({ tool_name: 'Bash', tool_input: { command: `echo x > store/${F}` }, cwd: root })
      expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason).toContain(F)
    })
    it('POSITIVE CONTROL: a read passes through the hook', () => {
      const r = run({ tool_name: 'Bash', tool_input: { command: `cat store/${F}` }, cwd: root })
      expect(r.stdout).toBe('')
      expect(r.status).toBe(0)
    })
  })
})

describe('the CLI, run from a hermetic copy of the install (<tmp>/scripts, <tmp>/store, <tmp>/agents/<name>)', () => {
  const realScripts = join(__dirname, '..', '..', 'scripts')
  let install: string
  let hook: string
  // Copy the gate and every local module it imports (relative ./ imports, followed transitively),
  // plus the exceptions module by its contract name when it exists.
  const copyGate = (dest: string) => {
    const todo = ['self-pace-gate.mjs', 'self-pace-local-exceptions.mjs']
    const seen = new Set<string>()
    while (todo.length) {
      const f = todo.pop()!
      if (seen.has(f) || !existsSync(join(realScripts, f))) continue
      seen.add(f)
      const text = readFileSync(join(realScripts, f), 'utf-8')
      copyFileSync(join(realScripts, f), join(dest, f))
      for (const m of text.matchAll(/(?:from\s+|import\s*\(\s*)['"]\.\/([^'"]+)['"]/g)) todo.push(m[1])
    }
  }
  beforeEach(() => {
    install = realpathSync(mkdtempSync(join(tmpdir(), 'kickstart-install-')))
    for (const d of ['scripts', 'store', 'agents/opsbot', 'agents/devbot']) mkdirSync(join(install, d), { recursive: true })
    copyGate(join(install, 'scripts'))
    hook = join(install, 'scripts', 'self-pace-gate.mjs')
  })
  afterEach(() => { rmSync(install, { recursive: true, force: true }) })

  const grant = (body: unknown = GOOD_CONFIG) =>
    writeFileSync(join(install, 'store', 'self-pace-exceptions.json'), typeof body === 'string' ? body : JSON.stringify(body))
  const run = (command: string, env: Record<string, string> = {}, agent = 'opsbot') =>
    spawnSync(process.execPath, [hook], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: root }),
      encoding: 'utf-8',
      env: { ...process.env, CLAUDE_PROJECT_DIR: join(install, 'agents', agent), ...env },
    })
  const isDeny = (r: { stdout: string }) => {
    if (!r.stdout.trim()) return false
    return JSON.parse(r.stdout).hookSpecificOutput?.permissionDecision === 'deny'
  }
  const DEMOSVC = `launchctl kickstart -k gui/${UID}/zz.fleet.demosvc-web`

  describe('with a grant in store/self-pace-exceptions.json', () => {
    beforeEach(() => grant())
    it('the granted agent restarts a zz.fleet.* service: not denied', () => {
      const r = run(DEMOSVC)
      expect(isDeny(r)).toBe(false)
      expect(r.status).toBe(0)
    })
    it('the plain form is not denied either', () => {
      expect(isDeny(run(`launchctl kickstart gui/${UID}/zz.fleet.demosvc-web`))).toBe(false)
    })
    it('the same command from another agent is denied', () => {
      expect(isDeny(run(DEMOSVC, {}, 'devbot'))).toBe(true)
    })
    it('the granted agent with a label outside the prefix is denied', () => {
      expect(isDeny(run(`launchctl kickstart -k gui/${UID}/com.apple.Dock.agent`))).toBe(true)
      expect(isDeny(run(`launchctl kickstart -k gui/${UID}/hu.fleetx.y`))).toBe(true)
    })
    it('the granted agent with another uid, flag, domain or subcommand is denied', () => {
      expect(isDeny(run(`launchctl kickstart -k gui/${UID + 1}/zz.fleet.demosvc-web`))).toBe(true)
      expect(isDeny(run(`launchctl kickstart -p gui/${UID}/zz.fleet.demosvc-web`))).toBe(true)
      expect(isDeny(run(`launchctl kickstart -k system/zz.fleet.demosvc-web`))).toBe(true)
      expect(isDeny(run(`launchctl bootout gui/${UID}/zz.fleet.demosvc-web`))).toBe(true)
    })
    it('chaining the granted command is denied', () => {
      expect(isDeny(run(`${DEMOSVC}; echo hi`))).toBe(true)
      expect(isDeny(run(`${DEMOSVC} && echo hi`))).toBe(true)
    })
    it('the granted agent cannot rewrite the grant file', () => {
      expect(isDeny(run(`echo '{}' > store/self-pace-exceptions.json`))).toBe(true)
    })
    it('a malformed grant file fails closed', () => {
      grant('{not json')
      expect(isDeny(run(DEMOSVC))).toBe(true)
    })
    it.each([
      'SELF_PACE_EXCEPTIONS_PATH', 'SELF_PACE_EXCEPTIONS', 'SELF_PACE_EXCEPTIONS_FILE', 'EXCEPTIONS_PATH',
    ])('env %s cannot redirect the config: an empty grant stays closed', (name) => {
      grant({})
      const permissive = join(root, 'permissive.json')
      writeFileSync(permissive, JSON.stringify(GOOD_CONFIG))
      expect(isDeny(run(DEMOSVC, { [name]: permissive }))).toBe(true)
    })
  })

  describe('with no config file', () => {
    it('a kickstart from the listed agent is denied (fail closed)', () => {
      const r = run(DEMOSVC)
      expect(isDeny(r)).toBe(true)
      expect(r.status === 0 || r.status === 2).toBe(true)
    })
    it('a plain kickstart is denied too', () => {
      expect(isDeny(run(`launchctl kickstart ${TARGET}`))).toBe(true)
    })
    it('an unrelated allowed command stays allowed', () => {
      const r = run('ls -la')
      expect(isDeny(r)).toBe(false)
      expect(r.status).toBe(0)
    })
    it('other launchctl subcommands stay denied', () => {
      expect(isDeny(run(`launchctl bootout gui/${UID}/${LABEL}`))).toBe(true)
    })
    it.each([
      'SELF_PACE_EXCEPTIONS_PATH', 'SELF_PACE_EXCEPTIONS', 'SELF_PACE_EXCEPTIONS_FILE', 'EXCEPTIONS_PATH',
      'SELF_PACE_STORE_DIR', 'MARVEEN_STORE_DIR', 'STORE_DIR',
    ])('env %s pointing at a permissive config has no effect', (name) => {
      const permissive = join(root, 'permissive.json')
      writeFileSync(permissive, JSON.stringify(GOOD_CONFIG))
      expect(isDeny(run(DEMOSVC, { [name]: name.endsWith('DIR') ? root : permissive }))).toBe(true)
    })
    it('a permissive store/ in cwd has no effect', () => {
      writeFileSync(join(store, 'self-pace-exceptions.json'), JSON.stringify(GOOD_CONFIG))
      expect(isDeny(run(DEMOSVC))).toBe(true)
    })
    it('devbot is denied as well', () => {
      expect(isDeny(run(DEMOSVC, {}, 'devbot'))).toBe(true)
    })
  })
})
