#!/usr/bin/env python3
"""device-keys-gate.py -- PreToolUse gate on the device_keys table and the voice-relay mint.

WHY THIS EXISTS (DEVKEYGATE1022): a 'messages'-scope device key bound to the
sender 'hanna' is the proof that a voice row came from the hang-front relay, and
the provenance gate trusts rows that carry it (PR rezsekmv/marveen#4). Such a key
can no longer be minted over HTTP; the only minting path left is the direct-SQLite
CLI `npm run voice-relay-key -- mint --out <file>` (scripts/voice-relay-key.ts).
A security review noted the remaining agent lane: any local agent with a shell can still
(a) run that mint, or (b) write the device_keys table of store/claudeclaw.db
directly (insert a key row bound to hanna, flip a row's scope or sender_id), or
(c) replace the DB file wholesale, which rewrites device_keys with it.

This hook closes the agent-Bash lane (and the Write/Edit lane onto the DB file)
for all three. What it blocks:
  1. an EXECUTED invocation of voice-relay-key with `mint` (npm/pnpm/yarn/bun run,
     tsx/node/bun/npx/npm exec on the script path, shell -c / eval / a pipe into
     a shell, an xargs that feeds `mint`), and an interpreter program (-c/-e
     argument, an interpreter heredoc, a pipe or here-string into an interpreter)
     that imports, requires or calls runVoiceRelayKey / createDeviceKey /
     voice-relay-key. `voice-relay-key -- list` stays allowed;
  2. a write SQL statement on device_keys (INSERT/REPLACE INTO, UPDATE ... SET,
     DELETE FROM, DROP/ALTER TABLE, RENAME TO, CREATE ... device_keys, the schema
     catalogue) against the LIVE DB -- a file named claudeclaw.db, or a target the
     gate cannot resolve (a variable, an xargs-fed path), or an ATTACH of it --
     sent through the sqlite3 CLI (argument, -cmd/--cmd, -init, stdin heredoc,
     here-string, pipe, `< file`, .read, `.read '|cmd'`, .shell/.system, .open),
     or as the SQL of an interpreter program (python sqlite3, better-sqlite3,
     bun:sqlite); plus .import into device_keys, .restore of the live DB, and
     .backup/.save/.clone/VACUUM INTO onto the live DB file;
  3. overwriting the live DB file (store/claudeclaw.db and its -wal/-shm/-journal)
     with cp/mv/install/rsync/ln/ditto/tee/dd/curl -o/wget -O, find -exec, a
     `>`/`>>`/`>|` redirect, an interpreter's copy/rename/open-for-write, and the
     Write/Edit/MultiEdit/NotebookEdit tools on that path.

What it must NOT block (the suite pins each one next to its blocked twin):
read-only sqlite3 on the DB, SELECT FROM device_keys included; kanban (or any
other table) writes, also when their VALUES mention device_keys; SQL on another
DB file; device_keys / voice-relay-key mentioned in prose -- echo, commit
messages, curl/json payloads, comments, a data heredoc, grep/rg, git log/diff,
a Python/JS string that is data rather than SQL; and `voice-relay-key -- list`.

WHAT IS REUSED FROM destructive-gate.py, AND WHAT IS NOT. That gate already
knows where a heredoc body starts and ends, which lines are comments, which
words are shell keywords and command wrappers, and how a payload shells out
(_SHELLOUT_RE); those helpers are loaded as a module (importlib: the file name
has a dash) and used as they are. Its block() is never called, and its file is
untouched. Two of its layers are NOT reused, each for a measured reason from
this gate's adversarial review (2026-10-22): its prose filter (scannable())
blanks every quoted argument containing a space, which is exactly where
`sqlite3 db "INSERT ..."` carries its SQL; and its regex-over-text payload
extraction ends a `python3 -c '...'` payload at the wrong quote when it sits
inside an outer double-quoted string, and does not walk interpreter flags
(`python3 -I -c`, `node --input-type=module -e`). So this gate parses the
shell itself: one linear scanner that splits chains and pipeline stages and
produces unquoted, unescaped words, with command substitutions and redirects
as their own items.

LINEAR TIME, BY CONSTRUCTION. The gate sits on every Bash call of every agent,
so a slow input is a fleet outage. The first version had a lazy-gap regex that
took 253 s on a 200 KB heredoc. Now: a whole command with none of the needles
in it (device_keys, voice-relay-key, the mint function names, claudeclaw,
sqlite3, .restore) is allowed before any parsing; every scanner is a single
forward pass (quotes, substitutions, SQL, host-language literals); and the few
regexes left are anchored or bounded, without nested or adjacent unbounded
quantifiers. The suite times 200 KB adversarial inputs.

THIS IS A SPEED BUMP, NOT A SANDBOX. Every agent runs as the same Unix user that
owns store/claudeclaw.db, and no static check of a command line can see through
obfuscation: base64 | sh, SQL or a table name assembled from variables or by
string concatenation, a script file written first and run afterwards (script
FILES are deliberately not scanned: the test suites that legitimately mention
device_keys would then be unrunnable), an unknown generator piped into sqlite3,
an archive extracted into store/. It stops a prompt-injected or careless agent
taking the obvious route; it does not stop a determined one. Say so whenever
this gate is cited as a control.

NO AGENT-SIDE OVERRIDE, BY DESIGN. There is no env var, flag, marker file or
approval that lets a blocked call through: every such switch is reachable by the
same agent (the approvals PATCH route accepts the shared dashboard token and
resolved_by is self-declared). The mint is run by a human -- the owner, or the
deploy operator -- in a normal terminal OUTSIDE any agent session:
    cd <install> && npm run voice-relay-key -- mint --out <file>
Claude Code `!` bash mode is not documented either way for PreToolUse; do not
rely on it.

FAILURE MODE: unlike its fail-closed siblings, a crash INSIDE this gate must not
wedge Bash for the whole fleet (it is wired on every agent, the main one
included, on every Bash call). On an internal exception -- including a failure to
load destructive-gate.py or a malformed event -- it falls back to a cheap raw
check: block only when the raw input carries both `device_keys` and a write
keyword, or both `voice-relay-key` and `mint`; otherwise allow. The failure is
recorded through hook_errlog with the exception TYPE only (never its message,
never the command). A file that does not even parse still exits non-zero, and
the fail-closed wrapper the scaffold puts around every gate turns that into a
block: that is a broken deploy, not a runtime input, and it is loud at once.

Block: exit 2 + reason on stderr, the same contract destructive-gate.py's block()
uses (Claude Code hands the stderr text back to the agent).
Tests: scripts/__tests__/device-keys-gate.test.py
"""
import importlib.util
import json
import os
import re
import shlex
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
# The install root comes from this file's own location, not from config or env:
# a gate must not have an input the gated side can rewrite.
PROJECT_ROOT = os.path.dirname(os.path.dirname(HERE))
GATE_TAG = 'DEVICE-KEYS-GATE'

MINT_COMMAND = 'cd %s && npm run voice-relay-key -- mint --out <file>' % PROJECT_ROOT


class GateError(Exception):
    """Raised for a block inside the analysis; main() turns it into exit 2.

    An exception rather than sys.exit() so the tests can call the checks
    directly, and so a block can never be confused with a crash: main() treats
    GateError as a verdict and every other Exception as a fault."""


def block(msg):
    raise GateError(msg)


def _load_dg():
    """destructive-gate.py as a module, or None if it cannot be loaded.

    None is not silently "allow": check_tool() raises, and main() drops to the
    raw fallback, which still blocks the plain shapes."""
    try:
        path = os.path.join(HERE, 'destructive-gate.py')
        spec = importlib.util.spec_from_file_location('_dkg_destructive_gate', path)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod
    except Exception:
        return None


dg = _load_dg()

# --- constants -----------------------------------------------------------------

# A command with none of these (case-folded, with quotes and backslashes removed
# so `device''_keys` and `device\_keys` still count) cannot reach any rule below.
NEEDLES = ('device_keys', 'voice-relay-key', 'createdevicekey', 'runvoicerelaykey',
           'claudeclaw', 'sqlite3', '.restore')
TABLE = 'device_keys'
# Targets whose write is a device_keys write: the table, and the schema catalogue
# (a writable_schema UPDATE rewrites the table definition without naming it).
GUARDED = {'device_keys', 'sqlite_master', 'sqlite_schema', 'sqlite_temp_master'}
# The live DB and its sidecars. A crafted -wal next to the DB is replayed into it
# on the next open, so the sidecars are the DB too.
DB_NAME_RE = re.compile(r'^claudeclaw\.db(?:-wal|-shm|-journal)?$')

PKG_MANAGERS = {'npm', 'pnpm', 'yarn', 'bun'}
MINT_RUNNERS = PKG_MANAGERS | {'node', 'nodejs', 'tsx', 'ts-node', 'deno', 'npx', 'pnpx', 'bunx',
                               'uv', 'corepack'}
COPY_CMDS = {'cp', 'mv', 'install', 'rsync', 'ln', 'ditto', 'gcp', 'gmv', 'scp'}
SQLITE_VALUE_FLAGS = {'-separator', '-newline', '-nullvalue', '-vfs', '-maxsize', '-mmap',
                      '-pagecache', '-lookaside', '-heap', '-escape'}
SUDO_VALUE_FLAGS = {'-u', '-g', '-C', '-D', '-h', '-p', '-r', '-t', '-U', '--user', '--group'}
ENV_VALUE_FLAGS = {'-u', '--unset', '-C', '--chdir', '-P'}
TRANSPARENT = {'exec', 'command', 'time', 'nohup', 'builtin', 'noglob', 'caffeinate'}
PY_RE = re.compile(r'^(?:python|pypy)(?:\d+(?:\.\d+)?)?$')
EVAL_FLAGS = {
    'python': {'-c'},
    'node': {'-e', '--eval', '-p', '--print'},
    'tsx': {'-e', '--eval', '-p', '--print'},
    'bun': {'-e', '--eval', '-p', '--print'},
    'perl': {'-e', '-E'},
    'ruby': {'-e'},
    'php': {'-r'},
    'shell': {'-c'},
}
# Flags that take their value as the NEXT word; without this list the value
# reads as the script file and the -c/-e after it is never reached.
INTERP_VALUE_FLAGS = {
    'python': {'-X', '-W', '--check-hash-based-pycs'},
    'node': {'-r', '--require', '--import', '--loader', '--experimental-loader', '-C',
             '--conditions', '--env-file', '--input-type', '--title', '--inspect-port',
             '--tsconfig', '--max-old-space-size'},
    'bun': {'--cwd', '--preload', '-r', '--require', '--config', '-c', '--tsconfig-override',
            '--env-file'},
    'perl': {'-I', '-M', '-m'},
    'ruby': {'-I', '-r'},
    'php': {'-d', '-c'},
    'shell': {'-o', '-O', '+o', '+O'},
}
INTERP_VALUE_FLAGS['tsx'] = INTERP_VALUE_FLAGS['node']
# Calls whose FIRST argument is SQL. A literal elsewhere (a bound parameter, a
# json.dumps payload, a print) is data unless it is itself shaped like SQL.
SQL_CALLS = {'execute', 'executescript', 'executemany', 'exec', 'prepare', 'run', 'query',
             'all', 'get', 'each', 'iterate', 'raw'}
SQL_VERBS = ('insert', 'update', 'delete', 'replace', 'drop', 'alter', 'create', 'with',
             'attach', 'vacuum', 'pragma', 'begin')
# Interpreter calls that write a file named by one of their arguments.
WRITE_FNS = {'copy', 'copyfile', 'copy2', 'copytree', 'move', 'rename', 'renames', 'replace',
             'copyFileSync', 'copyFile', 'renameSync', 'writeFileSync', 'writeFile',
             'appendFileSync', 'appendFile', 'cpSync', 'cp', 'link', 'symlink', 'linkSync',
             'symlinkSync', 'write_bytes', 'write_text', 'hardlink_to', 'symlink_to'}
MINT_CALL_RE = re.compile(r'\b(?:createDeviceKey|runVoiceRelayKey)\s{0,20}\(')
MAX_SHELLOUTS = 100


def _base(tok):
    return os.path.basename(tok)


# --- shell scanning (linear) ----------------------------------------------------

def _tick_end(s, i):
    """Index of the closing backtick at or after i (len(s) if none)."""
    n = len(s)
    while i < n:
        c = s[i]
        if c == '\\':
            i += 2
            continue
        if c == '`':
            return i
        i += 1
    return n


def _dq_end(s, i):
    """i is just after an opening double quote: index of the closing one."""
    n = len(s)
    while i < n:
        c = s[i]
        if c == '\\':
            i += 2
            continue
        if c == '"':
            return i
        if c == '$' and s.startswith('$(', i):
            i = _subst_end(s, i + 2)
            continue
        if c == '`':
            i = _tick_end(s, i + 1) + 1
            continue
        i += 1
    return n


def _subst_end(s, i):
    """i is just after `$(`: index after the matching `)`, quote-aware, so a `)`
    inside a quoted argument (`$(python3 -c 'print(1)')`) does not close it."""
    depth, n = 1, len(s)
    while i < n:
        c = s[i]
        if c == '\\':
            i += 2
            continue
        if c == "'":
            k = s.find("'", i + 1)
            i = n if k < 0 else k + 1
            continue
        if c == '"':
            i = _dq_end(s, i + 1) + 1
            continue
        if c == '`':
            i = _tick_end(s, i + 1) + 1
            continue
        if c == '(':
            depth += 1
        elif c == ')':
            depth -= 1
            if depth == 0:
                return i + 1
        i += 1
    return n


def _skip(s, i):
    """If s[i] opens a quote, escape or substitution, the index after it."""
    c = s[i]
    if c == '\\':
        return i + 2
    if c == "'":
        k = s.find("'", i + 1)
        return len(s) if k < 0 else k + 1
    if c == '"':
        return _dq_end(s, i + 1) + 1
    if c == '$' and s.startswith('$(', i):
        return _subst_end(s, i + 2)
    if c == '`':
        return _tick_end(s, i + 1) + 1
    return None


def _split(s, pipes):
    """Top-level split, one forward pass. pipes=False: command chains (&&, ||, ;,
    newline, a lone background &). pipes=True: the stages of one chain (|, |&).
    Quotes and substitutions are skipped whole, so a `;` or `|` inside them
    never cuts."""
    parts, start, i, n = [], 0, 0, len(s)
    while i < n:
        j = _skip(s, i)
        if j is not None:
            i = j
            continue
        c = s[i]
        if pipes:
            if c == '|' and not s.startswith('||', i) and not (i and s[i - 1] in '|>'):
                parts.append(s[start:i])
                i += 2 if s.startswith('|&', i) else 1
                start = i
                continue
            if s.startswith('||', i):
                i += 2
                continue
        else:
            if s.startswith('&&', i) or s.startswith('||', i):
                parts.append(s[start:i])
                i += 2
                start = i
                continue
            if c in ';\n':
                parts.append(s[start:i])
                i += 1
                start = i
                continue
            if c == '&' and not (i and s[i - 1] in '<>') and not s.startswith('&>', i):
                parts.append(s[start:i])
                i += 1
                start = i
                continue
            if c == '|':
                i += 2 if s.startswith('||', i) or s.startswith('|&', i) else 1
                continue
        i += 1
    parts.append(s[start:])
    return [p for p in parts if p.strip()]


class Stage(object):
    """One pipeline stage: unquoted words (text, quoted-with-space), redirects
    (op, target), command substitutions, here-strings. wsubs[i] lists the LIVE
    substitutions (raw text, inner command) inside words[i]: a backtick inside
    single quotes is a literal character and is not in it."""
    __slots__ = ('words', 'wsubs', 'redirs', 'subs', 'herestr')

    def __init__(self):
        self.words, self.wsubs, self.redirs, self.subs, self.herestr = [], [], [], [], []


def parse_stage(s):
    st = Stage()
    cur, in_word, spaced, op_next, wsub = [], False, False, [None], []
    n, i = len(s), 0

    def emit():
        if not cur and not in_word:
            return
        w = ''.join(cur)
        op = op_next[0]
        if op is not None:
            if op == '<<<':
                st.herestr.append(w)
            elif not op.startswith('<<'):
                st.redirs.append((op, w))
            op_next[0] = None
        else:
            st.words.append((w, spaced))
            st.wsubs.append(list(wsub))
        del wsub[:]

    while i < n:
        c = s[i]
        if c in ' \t\n':
            emit()
            cur, in_word, spaced = [], False, False
            i += 1
            continue
        if c == '#' and not in_word:
            k = s.find('\n', i)
            i = n if k < 0 else k
            continue
        if c == '\\':
            if i + 1 < n and s[i + 1] != '\n':
                cur.append(s[i + 1])
                in_word = True
            i += 2
            continue
        if c == "'":
            k = s.find("'", i + 1)
            seg = s[i + 1:] if k < 0 else s[i + 1:k]
            if ' ' in seg or '\t' in seg or '\n' in seg:
                spaced = True
            cur.append(seg)
            in_word = True
            i = n if k < 0 else k + 1
            continue
        if c == '"':
            j = i + 1
            while j < n and s[j] != '"':
                ch = s[j]
                if ch == '\\' and j + 1 < n:
                    nx = s[j + 1]
                    if nx in '"\\$`':
                        cur.append(nx)
                    elif nx != '\n':
                        cur.append(ch + nx)
                    j += 2
                    continue
                if ch == '$' and s.startswith('$(', j):
                    e = _subst_end(s, j + 2)
                    st.subs.append(s[j + 2:e - 1] if s[e - 1:e] == ')' else s[j + 2:e])
                    wsub.append((s[j:e], st.subs[-1]))
                    cur.append(s[j:e])
                    j = e
                    continue
                if ch == '`':
                    k = _tick_end(s, j + 1)
                    st.subs.append(s[j + 1:k])
                    wsub.append((s[j:k + 1], st.subs[-1]))
                    cur.append(s[j:k + 1])
                    j = k + 1
                    continue
                if ch in ' \t\n':
                    spaced = True
                cur.append(ch)
                j += 1
            in_word = True
            i = j + 1
            continue
        if c == '$' and s.startswith('$(', i):
            e = _subst_end(s, i + 2)
            st.subs.append(s[i + 2:e - 1] if s[e - 1:e] == ')' else s[i + 2:e])
            wsub.append((s[i:e], st.subs[-1]))
            cur.append(s[i:e])
            in_word = True
            i = e
            continue
        if c == '`':
            k = _tick_end(s, i + 1)
            st.subs.append(s[i + 1:k])
            wsub.append((s[i:k + 1], st.subs[-1]))
            cur.append(s[i:k + 1])
            in_word = True
            i = k + 1
            continue
        if c in '<>' or (c == '&' and s.startswith('&>', i)):
            if in_word and ''.join(cur).isdigit():
                cur, in_word, spaced = [], False, False    # an fd number, not a word
            else:
                emit()
                cur, in_word, spaced = [], False, False
            j = i + 1
            while j < n and s[j] in '<>|&' and j - i < 3:
                j += 1
            op_next[0] = s[i:j]
            i = j
            continue
        if c in '();|&':
            emit()
            cur, in_word, spaced = [], False, False
            i += 1
            continue
        cur.append(c)
        in_word = True
        i += 1
    emit()
    return st


def _resolve(words):
    """Index of the real command name past assignments, keywords and wrappers,
    plus (via_xargs, nested command strings from env -S). destructive's
    command_index() is the model; env options (-i, -u NAME, --, -S) and sudo
    are handled here instead, without changing destructive's behaviour."""
    i, xargs, nested = 0, False, []
    for _ in range(32):
        while i < len(words) and re.match(r'^[A-Za-z_][A-Za-z0-9_]*=', words[i][0]):
            i += 1
        if i >= len(words):
            return None, xargs, nested
        w, sp = words[i]
        if sp:
            return i, xargs, nested
        b = _base(w)
        if w in dg._KEYWORDS:
            i += 1
            continue
        if b in TRANSPARENT:
            i += 1
            while i < len(words) and words[i][0].startswith('-'):
                i += 1
            continue
        if b in ('sudo', 'doas'):
            i += 1
            while i < len(words) and words[i][0].startswith('-'):
                i += 2 if words[i][0] in SUDO_VALUE_FLAGS else 1
            continue
        if b == 'env':
            i += 1
            while i < len(words):
                t = words[i][0]
                if t == '--':
                    i += 1
                    break
                if t in ('-S', '--split-string') and i + 1 < len(words):
                    nested.append(words[i + 1][0])
                    i += 2
                    continue
                if t.startswith('--split-string='):
                    nested.append(t.split('=', 1)[1])
                    i += 1
                    continue
                if t in ENV_VALUE_FLAGS:
                    i += 2
                    continue
                if t.startswith('-'):
                    i += 1
                    continue
                break
            continue
        if b in dg._PREFIX_WRAPPERS:
            if b == 'xargs':
                xargs = True
            if b in ('flock', 'chroot'):
                j = i + 1
                while j < len(words) and words[j][0].startswith('-'):
                    j += 1
                i = j + 1
                continue
            nxt = dg._after_wrapper(words, i)
            if nxt is None:
                return None, xargs, nested
            i = nxt
            continue
        return i, xargs, nested
    return None, xargs, nested


def _through_runners(words, i):
    """Past npx/bunx/pnpx, `npm exec`/`npm x`, `pnpm dlx|exec`, `yarn dlx|exec`,
    `bun x`, `uv|poetry|pipenv|pdm run`: the index of the program they launch."""
    for _ in range(8):
        if i >= len(words):
            return i
        b = _base(words[i])
        j = i + 1
        if b in ('npx', 'bunx', 'pnpx'):
            while j < len(words) and words[j].startswith('-'):
                j += 2 if words[j] in ('-p', '--package') else 1
            if j < len(words):
                i = j
                continue
            return i
        if b in PKG_MANAGERS:
            while j < len(words) and words[j].startswith('-'):
                j += 2 if words[j] in ('-C', '--prefix', '--dir', '-w', '--workspace',
                                       '--filter', '--cwd') else 1
            if j < len(words) and words[j] in ('exec', 'x', 'dlx'):
                j += 1
                while j < len(words) and words[j].startswith('-') and words[j] != '--':
                    j += 2 if words[j] in ('-p', '--package', '-c', '--call') else 1
                if j < len(words) and words[j] == '--':
                    j += 1
                if j < len(words):
                    i = j
                    continue
            return i
        if b in ('uv', 'poetry', 'pipenv', 'pdm', 'hatch', 'rye'):
            while j < len(words) and words[j].startswith('-'):
                j += 1
            if j < len(words) and words[j] == 'run':
                j += 1
                while j < len(words) and words[j].startswith('-') and words[j] != '--':
                    j += 2 if words[j] in ('--with', '--python', '-p', '--project',
                                           '--directory', '--env-file', '--extra') else 1
                if j < len(words) and words[j] == '--':
                    j += 1
                if j < len(words):
                    i = j
                    continue
            return i
        return i
    return i


def _interp_kind(b):
    if PY_RE.match(b):
        return 'python'
    if b in ('node', 'nodejs'):
        return 'node'
    if b in ('tsx', 'ts-node', 'ts-node-esm'):
        return 'tsx'
    if b in ('bun', 'deno', 'perl', 'ruby', 'php', 'sqlite3'):
        return b
    if b in dg._SHELLS:
        return 'shell'
    return None


def _program(words, k):
    """(kind, payload or None, reads its program from stdin?) for words[k]."""
    kind = _interp_kind(_base(words[k]))
    if kind in (None, 'sqlite3'):
        return kind, None, False
    j = k + 1
    if kind == 'deno':
        while j < len(words) and words[j].startswith('-'):
            j += 1
        if j < len(words) and words[j] == 'eval':
            j += 1
            while j < len(words) and words[j].startswith('-'):
                j += 1
            return kind, (words[j] if j < len(words) else ''), False
        return kind, None, False
    ev, vf = EVAL_FLAGS[kind], INTERP_VALUE_FLAGS.get(kind, set())
    while j < len(words):
        t = words[j]
        if t in ev or (kind == 'python' and re.match(r'^-[bBdEhiIOqsSuvx]{1,8}c$', t)):
            return kind, (words[j + 1] if j + 1 < len(words) else ''), False
        if kind in ('node', 'tsx', 'bun') and t.startswith(('--eval=', '--print=')):
            return kind, t.split('=', 1)[1], False
        if t == '-' or (kind == 'shell' and t == '-s'):
            return kind, None, True
        if kind == 'python' and t == '-m':
            return kind, None, False
        if t == '--':
            return kind, None, j + 1 >= len(words)
        if t.startswith('-') or t.startswith('+'):
            j += 2 if t in vf else 1
            continue
        if kind == 'bun' and t == 'run':
            j += 1
            continue
        return kind, None, False          # a program FILE: stdin is its input
    return kind, None, True                # no file, no -c/-e: stdin IS the program


# --- target resolution ----------------------------------------------------------

def _read_text(path, cwd):
    """File contents at hook time, or None when it is not readable."""
    if not path:
        return None
    p = os.path.expanduser(path)
    if not os.path.isabs(p):
        if not cwd:
            return None
        p = os.path.join(cwd, p)
    try:
        with open(p, encoding='utf-8', errors='replace') as fh:
            return fh.read(2_000_000)
    except OSError:
        return None


def is_live_db_path(path, cwd):
    """Is this a path the shell or a file tool would WRITE as the live DB file?

    The name must be claudeclaw.db[-wal|-shm|-journal] AND it must land in a
    directory called store/ -- a copy written to /tmp/claudeclaw.db is a READ of
    the DB and stays allowed. A relative path is resolved against the cwd; with
    no cwd, `.`/`..`/a bare name are undecidable and count. A directory the gate
    cannot resolve ($STORE) counts: it does not let through what it cannot see
    through."""
    if not path:
        return False
    path = path.strip('\'"')
    if path.lower().startswith('file:'):
        path = path[5:].split('?', 1)[0]
    p = path.rstrip('/')
    if not DB_NAME_RE.match(_base(p).lower()):
        return False
    d = os.path.dirname(p) or '.'
    if '$' in d or '`' in d:
        return True
    d = os.path.expanduser(d)
    if os.path.isabs(d):
        return _base(os.path.normpath(d)) == 'store'
    if cwd:
        return _base(os.path.normpath(os.path.join(cwd, d))) == 'store'
    nd = os.path.normpath(d)
    return _base(nd) == 'store' or nd == '.' or nd.startswith('..')


def db_is_live(db, via_xargs=False):
    """Is the DATABASE a sqlite3 call opens the live one? Any path whose file name
    is claudeclaw.db counts (a symlink or a copy elsewhere is not the gate's
    business, the name is); an undecidable target counts; no DB at all (an
    in-memory session) does not -- an ATTACH of the live file is caught on the
    SQL side."""
    if via_xargs:
        return True
    if not db:
        return False
    d = db
    if d.lower().startswith('file:'):
        d = d[5:].split('?', 1)[0]
    if any(c in d for c in '$`{}*?'):
        return True
    return DB_NAME_RE.match(_base(d.rstrip('/')).lower()) is not None


# --- SQL (linear lexer) ---------------------------------------------------------

def sql_tokens(sql):
    """[(kind, value)]: 'w' bare word (lower-cased), 'q' quoted identifier
    ("x", [x], `x`, lower-cased), 's' string literal ('x'), 'p' punctuation.
    Comments are dropped. One forward pass; an unterminated quote or comment
    simply runs to the end. A SQL string VALUE is a single 's' (or, for SQLite's
    double-quoted string fallback, a single 'q') token, so prose inside a value
    never produces a keyword or a table name."""
    out, i, n = [], 0, len(sql)
    while i < n:
        c = sql[i]
        if c.isspace():
            i += 1
            continue
        if c == '-' and sql.startswith('--', i):
            k = sql.find('\n', i)
            i = n if k < 0 else k + 1
            continue
        if c == '/' and sql.startswith('/*', i):
            k = sql.find('*/', i + 2)
            i = n if k < 0 else k + 2
            continue
        if c == "'":
            j, buf = i + 1, []
            while True:
                k = sql.find("'", j)
                if k < 0:
                    buf.append(sql[j:])
                    j = n
                    break
                buf.append(sql[j:k])
                if sql.startswith("''", k):
                    buf.append("'")
                    j = k + 2
                    continue
                j = k + 1
                break
            out.append(('s', ''.join(buf)))
            i = j
            continue
        if c in '"`[':
            k = sql.find(']' if c == '[' else c, i + 1)
            out.append(('q', (sql[i + 1:] if k < 0 else sql[i + 1:k]).lower()))
            i = n if k < 0 else k + 1
            continue
        if c.isalnum() or c in '_$':
            j = i + 1
            while j < n and (sql[j].isalnum() or sql[j] in '_$'):
                j += 1
            out.append(('w', sql[i:j].lower()))
            i = j
            continue
        out.append(('p', c))
        i += 1
    return out


def _name_at(st, j):
    """(name, next index) of a possibly schema-qualified name at j."""
    if j >= len(st) or st[j][0] not in ('w', 'q'):
        return None, j
    if j + 2 < len(st) and st[j + 1] == ('p', '.') and st[j + 2][0] in ('w', 'q'):
        return st[j + 2][1], j + 3
    return st[j][1], j + 1


def _word(st, j):
    return st[j][1] if 0 <= j < len(st) and st[j][0] == 'w' else None


def _statement_write(st, cwd):
    """A reason if this one statement writes a guarded table or the live DB file.

    Matched by GRAMMAR, not by co-occurrence: the table must stand where the
    statement writes (INSERT INTO <t> followed by its column list/VALUES/SELECT,
    UPDATE <t> ... SET, DELETE FROM <t>, DROP/ALTER TABLE <t>, RENAME TO <t>),
    so prose that names both words ("UPDATE device_keys is now gated") is not a
    statement."""
    has_create = has_alter = False
    for j, (k, v) in enumerate(st):
        if k != 'w':
            continue
        if v == 'create':
            has_create = True
        elif v == 'alter':
            has_alter = True
        elif v == 'into':
            back = {_word(st, j - 1), _word(st, j - 2), _word(st, j - 3)}
            if 'vacuum' in back:
                tgt = st[j + 1][1] if j + 1 < len(st) and st[j + 1][0] in ('s', 'q') else None
                if tgt and is_live_db_path(tgt, cwd):
                    return 'VACUUM INTO the live DB file (%s)' % tgt
                continue
            if back & {'insert', 'replace'}:
                name, nx = _name_at(st, j + 1)
                if name in GUARDED and (_word(st, nx) in ('values', 'select', 'default', 'as', 'with')
                                        or (nx < len(st) and st[nx] == ('p', '('))):
                    return 'INSERT INTO %s' % name
        elif v == 'update' and _word(st, j - 1) != 'do':
            nx = j + 1
            if _word(st, nx) == 'or':
                nx += 2
            name, nx = _name_at(st, nx)
            if name in GUARDED and 'set' in {_word(st, nx), _word(st, nx + 1), _word(st, nx + 2),
                                             _word(st, nx + 3)}:
                return 'UPDATE %s ... SET' % name
        elif v == 'delete' and _word(st, j + 1) == 'from':
            name, nx = _name_at(st, j + 2)
            if name in GUARDED and (nx >= len(st) or _word(st, nx) in (
                    'where', 'returning', 'order', 'limit', 'as', 'indexed', 'not')):
                return 'DELETE FROM %s' % name
        elif v == 'table' and _word(st, j - 1) in ('drop', 'alter'):
            nx = j + 1
            if _word(st, nx) == 'if':
                nx += 2
            name, _nx = _name_at(st, nx)
            if name in GUARDED:
                return '%s TABLE %s' % (_word(st, j - 1).upper(), name)
        elif v == 'to' and _word(st, j - 1) == 'rename' and has_alter:
            name, _nx = _name_at(st, j + 1)
            if name in GUARDED:
                return 'ALTER TABLE ... RENAME TO %s' % name
    if has_create and any(k in ('w', 'q') and v == TABLE for k, v in st):
        return 'CREATE ... device_keys (a trigger, table, view or index on it)'
    return None


def sql_write_reason(sql, cwd=None, live=True):
    """A reason string if this SQL writes device_keys in the live DB (or the
    catalogue), or VACUUMs INTO the live DB file; else None. Dot-commands are not
    SQL; check_sqlite_script() handles them."""
    low = sql.lower()
    if not any(x in low for x in ('device_keys', 'sqlite_master', 'sqlite_schema',
                                  'sqlite_temp_master', 'vacuum')):
        return None
    live = live or 'claudeclaw' in low        # an ATTACH of the live file
    stmt = []
    for tok in sql_tokens(sql) + [('p', ';')]:
        if tok != ('p', ';'):
            stmt.append(tok)
            continue
        if stmt:
            why = _statement_write(stmt, cwd)
            if why and (live or why.startswith('VACUUM')):
                return 'a write SQL statement: %s' % why
        stmt = []
    return None


def check_sqlite_script(text, live, cwd, whole='', _depth=0):
    """SQL text fed to sqlite3 (argument, -cmd, heredoc, pipe, file). Lines that
    start with '.' are the CLI's own commands, everything else is SQL. `.open`
    switches the database mid-script, so liveness is tracked line by line."""
    if _depth > 4:
        block('sqlite3 .read nesting too deep to follow.')
    chunk = []

    def flush():
        why = sql_write_reason('\n'.join(chunk), cwd, live)
        if why:
            block('sqlite3: %s' % why)
        del chunk[:]

    for line in text.split('\n'):
        stripped = line.strip()
        if not stripped.startswith('.'):
            chunk.append(line)
            continue
        flush()
        parts = [w for w, _sp in parse_stage(stripped).words]
        if not parts:
            continue
        cmd, args = parts[0].lower(), parts[1:]
        rest = stripped[len(stripped.split(None, 1)[0]):].strip()
        if cmd in ('.shell', '.system'):
            check_bash(rest, cwd, _depth + 1)
        elif cmd == '.open':
            pos = [a for a in args if not a.startswith('-')]
            live = db_is_live(pos[-1]) if pos else False
        elif cmd == '.restore':
            if live:
                block('sqlite3 .restore of the live DB: that rewrites device_keys wholesale.')
        elif cmd in ('.backup', '.save', '.clone'):
            dest = [a for a in args if not a.startswith('-')]
            if dest and is_live_db_path(dest[-1], cwd):
                block('sqlite3 %s onto the live DB file: that replaces device_keys.' % cmd)
        elif cmd == '.import':
            pos = [a for a in args if not a.startswith('-')]
            if live and pos and pos[-1].lower().split('.')[-1].strip('"[]`') == TABLE:
                block('sqlite3 .import into device_keys.')
        elif cmd == '.read' and args:
            src = args[0]
            if src.startswith('|'):
                # `.read '|cmd'` runs cmd and reads its OUTPUT as SQL: the command
                # is checked as shell, and a legible producer as SQL.
                check_bash(src[1:], cwd, _depth + 1)
                body = _producer_output(parse_stage(src[1:]), cwd)
            else:
                body = _read_text(src, cwd)
            if body is None:
                # Not readable at hook time (written by this same command, or a
                # producer we cannot read). Decide on what the command shows.
                if live and TABLE in (text + whole).lower():
                    block('sqlite3 .read of a source the gate cannot read (%s) in a command '
                          'that names device_keys.' % src[:80])
                continue
            check_sqlite_script(body, live, cwd, whole, _depth + 1)
    flush()


def _subst_resolve(word, subs):
    """A word as SQL text, with each of its LIVE substitutions replaced: an
    echo/printf becomes its output, anything else an opaque placeholder."""
    for raw, inner in subs:
        ws = [w for w, _sp in parse_stage(inner).words]
        out = ' '.join(ws[1:]) if ws and _base(ws[0]) in ('echo', 'printf') else 'X'
        word = word.replace(raw, out, 1)
    return word


def _sqlite_parts(words):
    """(db, [indices of SQL words], [-init files]) of a sqlite3 argv (words[0]
    is sqlite3). sqlite3 accepts `--opt` as `-opt`, so both spellings are read."""
    db, sql, inits, i = None, [], [], 1
    while i < len(words):
        w = words[i]
        f = w[1:] if w.startswith('--') else w
        if f == '-cmd' and i + 1 < len(words):
            sql.append(i + 1)
            i += 2
            continue
        if f == '-init' and i + 1 < len(words):
            inits.append(words[i + 1])
            i += 2
            continue
        if f in SQLITE_VALUE_FLAGS:
            i += 2
            continue
        if w.startswith('-'):
            i += 1
            continue
        if db is None:
            db = w
        else:
            sql.append(i)
        i += 1
    return db, sql, inits


def _producer_output(st, cwd):
    """What a stage writes to stdout, when it is legible: echo/printf arguments,
    the files cat reads, a here-string."""
    idx, _x, _n = _resolve(st.words)
    if idx is None:
        return None
    ws = [w for w, _sp in st.words[idx:]]
    b = _base(ws[0])
    if b == 'echo':
        return ' '.join(w for w in ws[1:] if w not in ('-e', '-n', '-E'))
    if b == 'printf':
        return '\n'.join(ws[1:])
    if b == 'cat':
        parts = [_read_text(f, cwd) for f in ws[1:] if not f.startswith('-')]
        parts += st.herestr
        got = [p for p in parts if p]
        return '\n'.join(got) if got else None
    return None


# --- the command checks --------------------------------------------------------

def _is_vrk(tok):
    """voice-relay-key as a script name, package script or path (any extension)."""
    b = _base(tok).lower()
    return b == 'voice-relay-key' or re.match(r'^voice-relay-key\.(?:ts|mts|cts|js|mjs|cjs)$', b) is not None


def _check_mint(words, chain, via_xargs):
    b = _base(words[0]).lower()
    if not (b in MINT_RUNNERS or _interp_kind(b) or _is_vrk(words[0])):
        return
    start = next((i for i, w in enumerate(words) if _is_vrk(w)), None)
    if start is None:
        return
    rest = [w for w in words[start + 1:] if w != '--']
    low = [w.lower() for w in rest]
    if 'mint' in low:
        block('voice-relay-key mint: minting a device key is not an agent action.\n'
              '(the command: %s)' % ' '.join(words)[:160])
    sub = next((w for w in rest if not w.startswith('-')), None)
    if sub is not None and ('$' in sub or '`' in sub):
        block('voice-relay-key with a subcommand the gate cannot resolve (%s): it could be '
              'mint.' % sub[:40])
    if via_xargs and sub is None and re.search(r'(?<![\w-])mint(?![\w-])', chain.lower()):
        block('voice-relay-key behind xargs, in a pipeline that feeds it `mint`.')


def _positional(words):
    return [w for w in words[1:] if not w.startswith('-')]


def _check_overwrite(words, cwd):
    b = _base(words[0])
    if b == 'dd':
        for w in words[1:]:
            if w.startswith('of=') and is_live_db_path(w[3:], cwd):
                block('dd onto the live DB file (%s).' % w[3:])
        return
    if b == 'tee':
        for w in _positional(words):
            if is_live_db_path(w, cwd):
                block('tee onto the live DB file (%s).' % w)
        return
    if b in ('curl', 'wget'):
        flags = ('-o', '--output') if b == 'curl' else ('-O', '--output-document')
        for i, w in enumerate(words):
            tgt = None
            if w in flags and i + 1 < len(words):
                tgt = words[i + 1]
            elif w.startswith(flags[1] + '='):
                tgt = w.split('=', 1)[1]
            elif w.startswith(flags[0]) and len(w) > 2 and not w.startswith('--'):
                tgt = w[2:]
            if tgt and is_live_db_path(tgt, cwd):
                block('%s downloading onto the live DB file (%s).' % (b, tgt))
        return
    if b not in COPY_CMDS:
        return
    target = None
    for i, w in enumerate(words):
        if w in ('-t', '--target-directory') and i + 1 < len(words):
            target = words[i + 1]
        elif w.startswith('--target-directory='):
            target = w.split('=', 1)[1]
    pos = [w for w in _positional(words) if w != target]
    if target is None:
        if len(pos) < 2:
            return
        target, sources = pos[-1], pos[:-1]
    else:
        sources = pos
    if is_live_db_path(target, cwd):
        block('%s onto the live DB file (%s): that replaces device_keys wholesale.' % (b, target))
    # A directory target: the file lands under the source's own name.
    resolved = os.path.join(cwd, target) if cwd and not os.path.isabs(target) else target
    if (target.endswith('/') or os.path.normpath(target) in ('.', '..')
            or _base(os.path.normpath(target)) == 'store' or os.path.isdir(resolved)):
        for s in sources:
            if is_live_db_path(os.path.join(target, _base(s.rstrip('/'))), cwd):
                block('%s of %s into the live store/ directory: that replaces the DB file.'
                      % (b, s))


def _check_sqlite(words, wsubs, st, cwd, feed, via_xargs, whole):
    db, sql, inits = _sqlite_parts(words)
    live = db_is_live(db, via_xargs)
    texts = [_subst_resolve(words[i], wsubs[i] if i < len(wsubs) else []) for i in sql]
    for f in inits:
        body = _read_text(f, cwd)
        if body is not None:
            texts.append(body)
    for op, tgt in st.redirs:
        if op == '<':
            body = _read_text(tgt, cwd)
            if body is not None:
                texts.append(body)
    texts += st.herestr
    if feed:
        texts.append(feed)
    for t in texts:
        check_sqlite_script(t, live, cwd, whole)


def _dispatch(kind, payload, cwd, depth):
    """A SHELL program goes back through check_bash, where `echo "...device_keys..."`
    is prose exactly as it is at top level; any other program gets check_payload."""
    if not payload or not payload.strip():
        return
    if kind == 'shell':
        check_bash(payload, cwd, depth + 1)
    else:
        check_payload(payload, depth)


def _check_command(words, st, cwd, depth, feed, via_xargs, chain, whole, wsubs=()):
    """One resolved command (words[0] is the program). Returns the cwd after it."""
    b = _base(words[0])
    if b == 'eval':
        check_bash(' '.join(words[1:]), cwd, depth + 1)
        return cwd
    _check_mint(words, chain, via_xargs)
    k = _through_runners(words, 0)
    if k < len(words):
        if k:
            _check_mint(words[k:], chain, via_xargs)
        kind = _interp_kind(_base(words[k]))
        if kind == 'sqlite3':
            _check_sqlite(words[k:], list(wsubs)[k:], st, cwd, feed, via_xargs, whole)
        elif kind:
            kind, payload, stdin_prog = _program(words, k)
            if payload is not None:
                _dispatch(kind, payload, cwd, depth)
            if stdin_prog:
                for src in st.herestr + ([feed] if feed else []):
                    _dispatch(kind, src, cwd, depth)
    _check_overwrite(words, cwd)
    # find -exec <cmd> ... ;: the word after -exec is a command too.
    for j, w in enumerate(words):
        if w in dg._FIND_EXEC and j + 1 < len(words):
            end = j + 1
            while end < len(words) and words[end] not in (';', '+'):
                end += 1
            sub = words[j + 1:end]
            if sub:
                _check_command(sub, Stage(), cwd, depth, None, False, chain, whole)
    if b == 'cd':
        pos = _positional(words)
        tgt = pos[0] if pos else os.path.expanduser('~')
        if '$' in tgt or '`' in tgt:
            return None
        tgt = os.path.expanduser(tgt)
        if os.path.isabs(tgt):
            return os.path.normpath(tgt)
        return os.path.normpath(os.path.join(cwd, tgt)) if cwd else None
    return cwd


def _heredoc_ranges(cmd):
    data, code = dg._heredoc_body_ranges(cmd)
    return sorted(data + code)


HEREDOC_MARK_RE = re.compile(r'<<-?[ \t]*([\'"]?)[A-Za-z_][A-Za-z0-9_]*\1')


def _check_heredoc(body, opener, cwd, depth, whole):
    """A heredoc body goes to the command on its opener line -- or, when that is
    a plain `cat`, to the next pipeline stage (`cat <<X | sqlite3 db`)."""
    m = HEREDOC_MARK_RE.search(opener)
    pos = m.start() if m else len(opener)
    acc, chain = 0, opener
    for part in _split(opener, False):
        at = opener.find(part, acc)
        if at <= pos <= at + len(part):
            chain = part
            break
        acc = at + len(part)
    stages = _split(chain, True)
    cpos = pos - opener.find(chain) if opener.find(chain) >= 0 else pos
    acc, si = 0, len(stages) - 1
    for idx, part in enumerate(stages):
        at = chain.find(part, acc)
        if at <= cpos <= at + len(part):
            si = idx
            break
        acc = at + len(part)
    st = parse_stage(stages[si])
    i, xargs, _n = _resolve(st.words)
    if i is not None and _base(st.words[i][0]) == 'cat' and si + 1 < len(stages):
        st = parse_stage(stages[si + 1])
        i, xargs, _n = _resolve(st.words)
    if i is None or st.words[i][1]:
        return
    words = [w for w, _sp in st.words[i:]]
    k = _through_runners(words, 0)
    if k >= len(words):
        return
    kind = _interp_kind(_base(words[k]))
    if kind == 'sqlite3':
        db, _s, _i = _sqlite_parts(words[k:])
        check_sqlite_script(body, db_is_live(db, xargs), cwd, whole)
    elif kind:
        kind, _p, stdin_prog = _program(words, k)
        if stdin_prog:
            _dispatch(kind, body, cwd, depth)


def check_bash(cmd, cwd=None, _depth=0):
    if dg is None:
        raise RuntimeError('destructive-gate.py could not be loaded')
    if _depth > dg._MAX_NEST:
        block('nesting too deep to follow (%d levels).' % _depth)
    if cwd is not None:
        cwd = os.path.normpath(os.path.expanduser(cwd))
    ranges = _heredoc_ranges(cmd)
    text = dg._blank_ranges(cmd, ranges)
    text = dg._blank_ranges(text, dg._comment_ranges(text))
    entry_cwd = cwd
    for chain in _split(text, False):
        prev = None
        for raw_stage in _split(chain, True):
            st = parse_stage(raw_stage)
            for sub in st.subs:
                check_bash(sub, cwd, _depth + 1)
            for op, tgt in st.redirs:
                if '>' in op and is_live_db_path(tgt, cwd):
                    block('a shell redirect onto the live DB file (%s).' % tgt)
            idx, via_xargs, nested = _resolve(st.words)
            for n in nested:
                check_bash(n, cwd, _depth + 1)
            feed = _producer_output(prev, cwd) if prev is not None else None
            if idx is not None and not st.words[idx][1]:
                words = [w for w, _sp in st.words[idx:]]
                cwd = _check_command(words, st, cwd, _depth, feed, via_xargs, chain, cmd,
                                     st.wsubs[idx:])
            prev = st
    for a, b in ranges:
        opener = cmd[:max(0, a - 1)].rsplit('\n', 1)[-1]
        _check_heredoc(cmd[a:b], opener, entry_cwd, _depth, cmd)


# --- interpreter programs -------------------------------------------------------

def host_literals(code):
    """[(start, end, content)] of the string literals in Python/JS/Perl-ish code,
    one forward pass: '''…''' / \"\"\"…\"\"\" / `…` may span lines, '…' and "…"
    end at the line. Backslash escapes are resolved for quotes and backslashes."""
    out, i, n = [], 0, len(code)
    while i < n:
        c = code[i]
        if c in '\'"':
            tri = c * 3
            if code.startswith(tri, i):
                k = code.find(tri, i + 3)
                out.append((i, n if k < 0 else k + 3, code[i + 3:] if k < 0 else code[i + 3:k]))
                if k < 0:
                    break
                i = k + 3
                continue
            j, buf = i + 1, []
            while j < n and code[j] != c and code[j] != '\n':
                if code[j] == '\\' and j + 1 < n:
                    nx = code[j + 1]
                    buf.append(nx if nx in '\'"\\`' else code[j:j + 2])
                    j += 2
                    continue
                buf.append(code[j])
                j += 1
            if j < n and code[j] == c:
                out.append((i, j + 1, ''.join(buf)))
                i = j + 1
            else:
                # Unterminated on its line: a stray apostrophe in a comment. Skip
                # to the line end, not one character on -- restarting at i + 1 is
                # quadratic on a line of escaped quotes.
                i = j
            continue
        if c == '`':
            k = _tick_end(code, i + 1)
            out.append((i, min(k + 1, n), code[i + 1:k]))
            i = k + 1
            continue
        i += 1
    return out


def _callee_before(code, open_idx):
    """The identifier right before the '(' at open_idx."""
    j = open_idx - 1
    while j >= 0 and code[j] in ' \t':
        j -= 1
    e = j + 1
    while j >= 0 and (code[j].isalnum() or code[j] in '_$'):
        j -= 1
    return code[j + 1:e]


def enclosing_calls(code, lits):
    """{literal start: index of the '(' of the call whose argument list holds
    it}, for every literal, in ONE forward pass with a paren stack (parens inside
    literals are skipped). A per-literal backward scan was quadratic on a
    payload made of thousands of literals."""
    out, stack, i, n, li = {}, [], 0, len(code), 0
    while i < n:
        if li < len(lits) and lits[li][0] == i:
            out[i] = stack[-1] if stack else -1
            i = max(i + 1, lits[li][1])
            li += 1
            continue
        if li < len(lits) and lits[li][0] < i:
            li += 1
            continue
        c = code[i]
        if c == '(':
            stack.append(i)
        elif c == ')' and stack:
            stack.pop()
        i += 1
    return out


def _call_at(code, encl, start):
    at = encl.get(start, -1)
    return (_callee_before(code, at), at) if at >= 0 else (None, -1)


def _is_sql_literal(code, start, content, encl):
    name, at = _call_at(code, encl, start)
    if name in SQL_CALLS:
        # The FIRST argument only: nothing but whitespace (and a string prefix
        # like r/f/b) between the '(' and the literal.
        between = code[at + 1:start].strip()
        if between in ('', 'r', 'f', 'b', 'u', 'rb', 'br', 'fr', 'rf', 'R', 'F', 'B'):
            return True
    head = content.lstrip().lower()
    return any(head.startswith(v) and (len(head) == len(v) or not head[len(v)].isalnum())
               for v in SQL_VERBS)


def _blank_literals(code, lits):
    parts, prev = [], 0
    for s, e, _c in lits:
        parts.append(code[prev:s + 1])
        parts.append(' ' * max(0, e - s - 2))
        prev = max(prev, e - 1)
    parts.append(code[prev:])
    return ''.join(parts)


def _mint_in_payload(code, lits):
    low = code.lower()
    if not any(x in low for x in ('createdevicekey', 'runvoicerelaykey', 'voice-relay-key')):
        return None
    blanked = _blank_literals(code, lits)
    m = MINT_CALL_RE.search(blanked)
    if m:
        return 'a call to %s' % m.group(0).rstrip('( \t')
    for line in blanked.split('\n'):
        if ('createDeviceKey' in line or 'runVoiceRelayKey' in line) and \
                re.search(r'\b(?:import|require|from)\b', line):
            return 'an import of the mint function'
    for s, _e, content in lits:
        if 'voice-relay-key' not in content.lower():
            continue
        before = code[max(0, s - 40):s].rstrip()
        while before and before[-1] in 'rRbBfFuU' and len(before) > 1 and not before[-2].isalnum():
            before = before[:-1]
        if before.endswith(('require(', 'import(', 'from', 'import')) or \
                re.search(r'(?:require|import)\s{0,10}\(\s{0,10}$', before):
            return 'an import of the voice-relay-key module'
    return None


def _payload_writes_db(code, lits, encl):
    for idx, (s, e, content) in enumerate(lits):
        if not is_live_db_path(content, None) or '/' not in content.replace('\\', '/'):
            continue
        name, _at = _call_at(code, encl, s)
        if name in WRITE_FNS:
            return '%s onto %s' % (name, content)
        if name == 'open' and idx + 1 < len(lits) and lits[idx + 1][0] < e + 40:
            mode = lits[idx + 1][2]
            if len(mode) <= 4 and re.search(r'[wax+]', mode):
                return 'open(..., %r) on %s' % (mode, content)
        tail = code[e:e + 60]
        if re.match(r'\s{0,5}\)\s{0,5}\.\s{0,5}(?:write_bytes|write_text|symlink_to|hardlink_to)\b', tail):
            return 'a Path write onto %s' % content
    return None


def check_payload(payload, _depth=0):
    """An interpreter's program: the mint called or imported, SQL that writes
    device_keys in the live DB, the DB file overwritten, or a shell-out (which
    goes back through check_bash)."""
    low = payload.lower()
    if not any(n in low for n in NEEDLES):
        return
    lits = host_literals(payload)
    encl = enclosing_calls(payload, lits)
    why = _mint_in_payload(payload, lits)
    if why:
        block('an interpreter program with %s (voice-relay-key mint / createDeviceKey).\n'
              '(program: %s)' % (why, ' '.join(payload.split())[:160]))
    if TABLE in low or 'sqlite_' in low or 'vacuum' in low:
        # The SQL runs against the live DB if the program names it, or if the gate
        # cannot see which DB it opens (no DB-file literal at all).
        live = 'claudeclaw' in low or not any(
            c.strip().lower().endswith(('.db', '.sqlite', '.sqlite3', '.db3')) or c == ':memory:'
            for _s, _e, c in lits)
        for s, _e, content in lits:
            cl = content.lower()
            if (TABLE in cl or 'sqlite_' in cl or 'vacuum' in cl) and \
                    _is_sql_literal(payload, s, content, encl):
                why = sql_write_reason(content, None, live)
                if why:
                    block('an interpreter program carrying %s' % why)
    if 'claudeclaw' in low:
        why = _payload_writes_db(payload, lits, encl)
        if why:
            block('an interpreter program that writes the live DB file: %s.' % why)
    for count, m in enumerate(dg._SHELLOUT_RE.finditer(payload)):
        if count >= MAX_SHELLOUTS or _depth >= dg._MAX_NEST:
            break
        open_idx = payload.index('(', m.end() - 1)
        # Bounded: a shell-out argument longer than this is not a command line.
        close = _subst_end(payload[:open_idx + 4000], open_idx + 1)
        arg = payload[open_idx + 1:close - 1]
        words = [c for _s, _e, c in host_literals(arg)]
        if not words:
            continue
        if arg.lstrip().startswith('['):
            inner = ' '.join(shlex.quote(w) for w in words)
        else:
            inner = ' '.join(words)
        check_bash(inner, None, _depth + 1)


# --- tools ------------------------------------------------------------------------

def needs_analysis(raw):
    low = raw.lower()
    if any(n in low for n in NEEDLES):
        return True
    flat = low.replace('\\', '').replace("'", '').replace('"', '')
    return any(n in flat for n in NEEDLES)


def check_file_tool(path, cwd=None):
    if path and is_live_db_path(path, cwd):
        block('writing the live DB file (%s) with a file tool replaces device_keys.' % path)


def check_tool(ev):
    if dg is None:
        raise RuntimeError('destructive-gate.py could not be loaded')
    tool = ev.get('tool_name') or ''
    inp = ev.get('tool_input') or {}
    if not isinstance(inp, dict):
        raise TypeError('tool_input is not an object')
    ev_cwd = ev.get('cwd')
    if not (isinstance(ev_cwd, str) and ev_cwd.strip()):
        ev_cwd = None
    if tool == 'Bash':
        cmd = str(inp.get('command') or '')
        if needs_analysis(cmd):
            check_bash(cmd, ev_cwd)
    elif tool in ('Write', 'Edit', 'MultiEdit', 'NotebookEdit'):
        check_file_tool(str(inp.get('file_path') or inp.get('notebook_path') or ''), ev_cwd)


# --- the crash fallback --------------------------------------------------------

RAW_WRITE_RE = re.compile(r'\b(?:insert|update|delete|replace|drop|alter|create|upsert)\b', re.I)


def raw_fallback_blocks(raw):
    """The cheap check used when the real analysis crashed. Deliberately crude in
    BOTH directions: it may block a prose mention that pairs the two words, and
    it lets every obfuscated shape through. It exists so a gate bug degrades to a
    narrow block, not to a fleet-wide Bash outage and not to an open door."""
    low = raw.lower()
    if TABLE in low and RAW_WRITE_RE.search(raw):
        return True
    return 'voice-relay-key' in low and re.search(r'\bmint\b', low) is not None


def _report(message):
    try:
        sys.path.insert(0, HERE)
        import hook_errlog
        hook_errlog.report('device-keys-gate', message)
    except Exception:
        pass


def _deny(reason):
    sys.stderr.write(
        '%s: BLOCKED.\n%s\n\n'
        'This is not a permission error and there is no override you can set: no env '
        'var, flag, marker file or approval lets it through, because every such switch '
        'is reachable by the agent it is meant to stop. device_keys is written only '
        'by the voice-relay-key mint, and the mint is run by a human -- the owner or '
        'the deploy operator -- in a normal terminal OUTSIDE any agent session:\n'
        '    %s\n'
        'If this is genuinely needed, tell the owner what and why, and hand them that '
        'command. Reading the table (SELECT, .schema) and `voice-relay-key -- list` '
        'stay allowed.\n' % (GATE_TAG, reason, MINT_COMMAND))
    sys.exit(2)


def main():
    raw = sys.stdin.read()
    try:
        ev = json.loads(raw)
        if not isinstance(ev, dict):
            raise ValueError('event is not an object')
    except Exception as exc:
        # Unreadable input: no structure to analyse, so only the crude check.
        _report('unreadable hook input (%s), raw fallback used' % type(exc).__name__)
        if raw_fallback_blocks(raw):
            _deny('Unreadable hook input that pairs device_keys with a write keyword, or '
                  'voice-relay-key with mint (fallback check).')
        sys.exit(0)
    try:
        check_tool(ev)
    except GateError as g:
        _deny(str(g))
    except Exception as exc:
        # Fail toward the raw check, NOT toward a blanket block: this gate sits on
        # every Bash call of every agent, and a parser bug must not take the
        # fleet's shell down. Only the exception TYPE is logged.
        _report('internal error (%s), raw fallback used' % type(exc).__name__)
        inp = ev.get('tool_input')
        if isinstance(inp, dict):
            subject = str(inp.get('command') or inp.get('file_path') or '')
        else:
            subject = str(inp or '')
        if raw_fallback_blocks(subject):
            _deny('The gate hit an internal error (%s); the fallback check matched '
                  '(device_keys with a write keyword, or voice-relay-key with mint).'
                  % type(exc).__name__)
        sys.exit(0)
    sys.exit(0)


if __name__ == '__main__':
    main()
