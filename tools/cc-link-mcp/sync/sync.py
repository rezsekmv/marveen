#!/usr/bin/env python3
"""Session sync: summarize idle Claude Code sessions to the main agent and
answer its follow-up questions, through the cc-link MCP server.

Meant to run from launchd (or cron) every hour. Each run:
  1. finds sessions whose transcript has new entries since the last summary
     and no new entry for IDLE_MIN minutes,
  2. has `claude -p` summarize the new part and send it with <prefix>_message,
  3. answers folder messages the main agent sent to the sync folder
     (questions about a `session:<id8>`), from the referenced transcripts.

State lives in CC_LINK_SYNC_DIR (default ~/.cc-link/sync):
  sent.tsv      one row per summary: session id, date, category, sent|skipped,
                message id, transcript line count covered so far
  answered.txt  ids of main-agent messages already handled
  run/          cwd of every `claude -p` call; its cc-link folder key is the
                address for questions (folder:<key>)

Configuration (environment):
  CC_LINK_AGENT_NAME       tool prefix, as in the MCP server env (default agent)
  CC_LINK_SYNC_DIR         state directory (default ~/.cc-link/sync)
  CC_LINK_SYNC_LANG        language of the summaries (default English)
  CC_LINK_SYNC_MODEL       model for summaries and answers (default sonnet)
  CC_LINK_SYNC_SINCE       YYYY-MM-DD; ignore transcript entries before this date
                           (avoids summarizing the whole history on the first run)
  CC_LINK_SYNC_CATEGORIES  LABEL=path pairs, comma separated, e.g.
                           WORK=~/code/work,HOME=~/code/home (default: none, OTHER)
  CC_LINK_SYNC_IDLE_MIN    minutes without new entries before a session is
                           summarized (default 30)

The dashboard URL and device key are read from the cc-link entry in
~/.claude.json (user-scope registration), never from this script's env.
"""
import fcntl, glob, hashlib, json, os, re, subprocess, sys, threading, time, urllib.request
from datetime import datetime

HOME = os.path.expanduser('~')
HERE = os.path.dirname(os.path.realpath(__file__))
PREFIX = re.sub(r'[^a-z0-9]+', '_', os.environ.get('CC_LINK_AGENT_NAME', 'agent').lower()).strip('_') or 'agent'
SYNC = os.path.expanduser(os.environ.get('CC_LINK_SYNC_DIR', '~/.cc-link/sync'))
LANG = os.environ.get('CC_LINK_SYNC_LANG', 'English')
MODEL = os.environ.get('CC_LINK_SYNC_MODEL', 'sonnet')
SINCE = os.environ.get('CC_LINK_SYNC_SINCE', '')
IDLE_SEC = int(os.environ.get('CC_LINK_SYNC_IDLE_MIN', '30')) * 60
CATEGORIES = [(label.strip(), os.path.realpath(os.path.expanduser(path.strip())).rstrip('/'))
              for label, _, path in (p.partition('=') for p in os.environ.get('CC_LINK_SYNC_CATEGORIES', '').split(',') if '=' in p)]
LOG = f'{SYNC}/sent.tsv'
ANSWERED = f'{SYNC}/answered.txt'
RUN_DIR = f'{SYNC}/run'
MCP_CONFIG = f'{SYNC}/mcp.json'  # cc-link only, for the locked-down claude -p (holds the device key: 0600, removed after the run)
EMPTY_DIR = f'{SYNC}/empty'  # TELEGRAM_STATE_DIR for children, so a channel plugin can never touch the real one
TIMEOUT_SEC = 900
MAX_CHARS = 400_000  # keep the tail of huge transcripts; chunk if summaries get too shallow
MESSAGE_TOOL = f'mcp__cc-link__{PREFIX}_message'
INBOX_TOOL = f'mcp__cc-link__{PREFIX}_inbox'


def folder_key(path):
    """Same as the MCP server: first 8 hex chars of sha256(realpath(folder))."""
    return hashlib.sha256(os.path.realpath(path).encode()).hexdigest()[:8]


def category(cwd):
    for label, root in CATEGORIES:
        if cwd and (cwd == root or cwd.startswith(root + '/')):
            return label
    return 'OTHER'


def covered():
    """session id -> (transcript lines already handled, whether any summary was sent).

    Rows without a line count give 0; a row was sent when it has a message id (or `queued`).
    """
    out = {}
    if not os.path.exists(LOG):
        return out
    for line in open(LOG, errors='replace'):
        f = line.rstrip('\n').split('\t')
        if len(f) < 4 or not re.fullmatch(r'[0-9a-f-]{36}', f[0]):
            continue
        n = int(f[5]) if len(f) > 5 and f[5].isdigit() else 0
        sent = len(f) > 4 and (f[4].isdigit() or f[4] == 'queued')
        prev_n, prev_sent = out.get(f[0], (0, False))
        out[f[0]] = (max(prev_n, n), prev_sent or sent)
    return out


def first_line_since(lines, day):
    """Index of the first entry dated `day` (YYYY-MM-DD) or later."""
    for i, line in enumerate(lines):
        m = re.search(r'"timestamp":\s*"(\d{4}-\d\d-\d\d)', line)
        if m and m.group(1) >= day:
            return i
    return len(lines)


def start_line(lines, done):
    """Where the next summary of a transcript starts (`done` = lines already handled)."""
    if done:
        return done
    return first_line_since(lines, SINCE) if SINCE else 0


def last_activity(lines):
    """Epoch of the newest transcript entry (file mtime gets bumped without new entries)."""
    for line in reversed(lines):
        m = re.search(r'"timestamp":\s*"([^"]+)"', line)
        if m:
            try:
                return datetime.fromisoformat(m.group(1).replace('Z', '+00:00')).timestamp()
            except ValueError:  # e.g. a fraction Python 3.9 cannot parse: try an older entry
                continue
    return 0


def extract(lines, start):
    """User prompts and assistant prose from line `start` on; tool calls and results dropped."""
    buf, cwd, first_ts = [], None, None
    for i, line in enumerate(lines):
        try:
            d = json.loads(line)
        except ValueError:
            continue
        cwd = cwd or d.get('cwd')
        if i < start or d.get('isMeta') or d.get('isSidechain'):
            continue
        first_ts = first_ts or d.get('timestamp')
        c = d.get('message', {}).get('content')
        texts = [c] if isinstance(c, str) else [b.get('text', '') for b in c or [] if b.get('type') == 'text']
        texts = [t for t in texts if t.strip()]
        if d.get('type') == 'user':  # tool results are not text blocks; '<' marks reminders and command wrappers
            buf += ['\n## U: ' + t[:1500] for t in texts if not t.startswith('<')]
        elif d.get('type') == 'assistant':
            buf += ['A: ' + t[:800] for t in texts]
    return '\n'.join(buf)[-MAX_CHARS:], cwd, first_ts


def brief(name):
    return (open(f'{HERE}/{name}').read()
            .replace('{{TOOL}}', f'{PREFIX}_message').replace('{{LANG}}', LANG))


def write_mcp_config():
    entry = json.load(open(f'{HOME}/.claude.json'))['mcpServers']['cc-link']
    tmp = f'{MCP_CONFIG}.{os.getpid()}'
    with os.fdopen(os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as fh:
        json.dump({'mcpServers': {'cc-link': entry}}, fh)
    os.replace(tmp, MCP_CONFIG)  # a fresh 0600 file, whatever mode an older one had


def parse_stream(out):
    """(message ids the tool reported as sent, final text) from claude's stream-json output."""
    ids, text = [], ''
    for line in out.splitlines():
        try:
            ev = json.loads(line)
        except ValueError:
            continue
        if ev.get('type') == 'user':
            for b in ev.get('message', {}).get('content') or []:
                if isinstance(b, dict) and b.get('type') == 'tool_result':
                    c = b.get('content')
                    c = c if isinstance(c, str) else ' '.join(x.get('text', '') for x in c or [])
                    ids += re.findall(r'^(?:sent|answer) \(id (\d+)\)', c)
                    if c.startswith('queued in outbox'):  # the MCP server sends it later: as good as sent
                        ids.append('queued')
        elif ev.get('type') == 'result':
            text = ev.get('result') or ''
    return ids, text


def check_lockdown(ev):
    """The init event must show only cc-link: the lockdown depends on CLI flags, so verify it on every run."""
    tools = ev.get('tools') or []
    servers = [m.get('name') for m in ev.get('mcp_servers') or []]
    if not tools or any(not t.startswith('mcp__cc-link__') for t in tools) or servers != ['cc-link']:
        raise RuntimeError(f'lockdown not in effect (tools={tools}, mcp={servers})')


def claude(prompt, model, tool):
    """claude -p over untrusted text: only `tool`, no built-in tools, no user settings, plugins or other MCP servers.

    Returns (sent ids, final text, returncode, stderr tail). Killed before the first model turn when the
    init event shows anything beyond cc-link; on timeout the output so far is still parsed, so a send that
    already happened is recorded.
    """
    p = subprocess.Popen(['claude', '-p', '--model', model, '--tools', '', '--strict-mcp-config', '--mcp-config', MCP_CONFIG,
                          '--setting-sources', '', '--permission-mode', 'dontAsk', '--allowedTools', tool,
                          '--output-format', 'stream-json', '--verbose'],
                         stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                         cwd=RUN_DIR, env={**os.environ, 'TELEGRAM_STATE_DIR': EMPTY_DIR})
    err = []
    threading.Thread(target=lambda: (p.stdin.write(prompt), p.stdin.close()), daemon=True).start()
    threading.Thread(target=lambda: err.append(p.stderr.read()), daemon=True).start()
    timer = threading.Timer(TIMEOUT_SEC, p.kill)
    timer.start()
    out, checked = [], False
    try:
        for line in p.stdout:
            out.append(line)
            if not checked:
                try:
                    ev = json.loads(line)
                except ValueError:
                    continue
                if ev.get('type') != 'system':  # fail closed: nothing may happen before the init check
                    raise RuntimeError(f'no init event before {ev.get("type")}')
                if ev.get('subtype') == 'init':
                    check_lockdown(ev)
                    checked = True
    except RuntimeError:
        p.kill()
        raise
    finally:
        p.wait()
        timer.cancel()
    ids, text = parse_stream(''.join(out))
    return ids, text, p.returncode, ''.join(err)[-300:]


def has_line(text, word):
    """`word` alone on a line, ignoring markdown and punctuation around it."""
    return any(re.sub(r'[^A-Za-z]', '', line) == word for line in text.splitlines())


def server_env():
    """The cc-link MCP server's env from its user-scope registration."""
    return json.load(open(f'{HOME}/.claude.json'))['mcpServers']['cc-link']['env']


def api_get(path):
    env = server_env()
    req = urllib.request.Request(env['MARVEEN_URL'].rstrip('/') + path,
                                 headers={'Authorization': 'Bearer ' + env['MARVEEN_DEVICE_KEY']})
    return json.load(urllib.request.urlopen(req, timeout=10))


def whoami():
    """The call the MCP server needs before sending; None when the dashboard is unreachable."""
    try:
        return api_get('/api/auth/whoami')
    except (OSError, ValueError):  # HTTPError included: whoami must answer 200
        return None


def summarize(sid, cat, cwd, date, text, partial):
    header = f'[SYNC] [{cat}] {os.path.basename(cwd or "?")} · {date} · session:{sid[:8]}'
    if partial:
        header += ' · continued'
    prompt = (brief('summary-brief.md') + f'\n\nHeader (first line of the message): {header}\n'
              + ('This is a CONTINUATION: only the part since the previous summary is below; summarize only that.\n' if partial else '')
              + '\n--- TRANSCRIPT START ---\n' + text + '\n--- TRANSCRIPT END ---\n')
    ids, text, rc, err = claude(prompt, MODEL, MESSAGE_TOOL)
    if ids:  # taken from the tool result, so a sent summary is never sent again
        return 'sent', ids[0]
    if has_line(text, 'SKIP'):
        return 'skipped', '-'
    raise RuntimeError(f'nothing sent (rc={rc}): {text[-300:]} | stderr: {err}')


def sync_session(f, done, now, dry):
    sid = os.path.basename(f)[:-6]
    lines = open(f, errors='replace').read().splitlines()
    handled, was_sent = done.get(sid, (0, False))
    start = start_line(lines, handled)
    if start >= len(lines) or now - last_activity(lines) < IDLE_SEC:
        return
    text, cwd, ts = extract(lines, start)
    cat = category(cwd)
    if dry:
        print(f'would send {sid[:8]} {cat} lines {start}-{len(lines)} chars={len(text)}')
        return
    row = summarize(sid, cat, cwd, (ts or '')[:10], text, was_sent) if text.strip() else ('skipped', '-')
    with open(LOG, 'a') as fh:
        fh.write('\t'.join([sid, time.strftime('%Y-%m-%d'), cat, row[0], row[1], str(len(lines))]) + '\n')
    print(f'{time.strftime("%F %T")} {sid[:8]} {cat} {row[0]} {row[1]}')


def sync_sessions(dry):
    done = covered()
    now = time.time()
    run_project = project_dir_name(RUN_DIR)
    for f in sorted(glob.glob(f'{HOME}/.claude/projects/*/*.jsonl'), key=os.path.getmtime):
        if os.path.basename(os.path.dirname(f)) == run_project:  # our own claude -p calls
            continue
        try:  # one bad transcript must not block the others
            sync_session(f, done, now, dry)
        except Exception as e:
            print(f'{os.path.basename(f)[:8]} failed: {e}', file=sys.stderr)


def session_files(sid8, run_project):
    """Transcripts of an already summarized session (never the sync's own claude -p runs)."""
    known = [sid for sid in covered() if sid.startswith(sid8)]
    return [f for sid in known for f in glob.glob(f'{HOME}/.claude/projects/*/{sid}.jsonl')
            if os.path.basename(os.path.dirname(f)) != run_project]


def answer_questions(who):
    """Answer the main agent's folder messages to RUN_DIR from the referenced transcripts."""
    sender, main_agent = who.get('sender_id'), who.get('mainAgentId')
    if not sender or not main_agent:
        print('answer step skipped: whoami has no sender_id/mainAgentId', file=sys.stderr)
        return
    key = folder_key(RUN_DIR)
    pending = api_get(f'/api/messages?agent={sender}&status=pending')
    if any(f'folder:{key}' in (row.get('origin_note') or '') for row in pending):
        claude(f'Call {PREFIX}_inbox once, then reply OK.', 'haiku', INBOX_TOOL)  # a starting session claims them
    state_dir = os.path.expanduser(server_env().get('CC_LINK_STATE_DIR') or '~/.cc-link')
    received = f'{state_dir}/folders/{key}/received.jsonl'
    if not os.path.exists(received):
        return
    answered = set(open(ANSWERED).read().split()) if os.path.exists(ANSWERED) else set()
    run_project = project_dir_name(RUN_DIR)
    for line in open(received):
        try:
            msg = json.loads(line)
        except ValueError:  # blank or partially written line
            continue
        mid = str(msg.get('id'))
        # 'answer' entries are replies to our own messages, not questions: answering them could ping-pong
        if mid in answered or msg.get('kind') != 'inbox' or msg.get('from') != main_agent:
            continue
        sid8s = sorted(set(re.findall(r'session:([0-9a-f]{8})', msg.get('text', ''))))
        files = [f for sid8 in sid8s for f in session_files(sid8, run_project)]
        share = MAX_CHARS // max(len(files), 1)  # keep the whole prompt within MAX_CHARS
        transcripts = ''
        for f in files:
            text, cwd, _ = extract(open(f, errors='replace').read().splitlines(), 0)
            transcripts += f'\n--- TRANSCRIPT session:{os.path.basename(f)[:8]} ({cwd}) ---\n{text[-share:]}\n'
        ids, text, rc, err = claude(brief('answer-brief.md') + f'\n\nMessage id: {mid}\n--- MESSAGE ---\n{msg.get("text", "")}\n'
                           + (transcripts or '\n(no summarized session referenced or found)\n'), MODEL, MESSAGE_TOOL)
        if not ids and not has_line(text, 'NOOP'):
            print(f'answer {mid} failed (rc={rc}): {text[-300:]} | stderr: {err}', file=sys.stderr)
            continue
        with open(ANSWERED, 'a') as fh:
            fh.write(mid + '\n')
        answered.add(mid)  # received.jsonl can hold the same message twice
        print(f'{time.strftime("%F %T")} answer to {mid}: {"sent " + ids[0] if ids else "NOOP"}')


def project_dir_name(path):
    """Claude Code's ~/.claude/projects/<name> for a working directory."""
    return re.sub(r'[^A-Za-z0-9]', '-', os.path.realpath(path))


def secure_state():
    """0700 dirs, 0600 files, also for ones created earlier or by launchd (sync.log)."""
    for d in (SYNC, RUN_DIR, EMPTY_DIR):
        os.makedirs(d, mode=0o700, exist_ok=True)
        os.chmod(d, 0o700)
    for name in os.listdir(SYNC):
        path = f'{SYNC}/{name}'
        if os.path.isfile(path):
            os.chmod(path, 0o600)


def main(dry):
    secure_state()
    if dry:
        print(f'questions go to folder:{folder_key(RUN_DIR)}')
        sync_sessions(True)
        return
    who = whoami()
    if not who:
        print(f'{time.strftime("%F %T")} dashboard unreachable, skipping')
        return
    write_mcp_config()
    try:
        sync_sessions(False)
        try:
            answer_questions(who)
        except Exception as e:
            print(f'answer step failed: {e}', file=sys.stderr)
    finally:
        os.remove(MCP_CONFIG)  # the device key does not stay on disk outside ~/.claude.json


if __name__ == '__main__':
    os.umask(0o077)  # state, log and mcp.json are private
    os.makedirs(SYNC, mode=0o700, exist_ok=True)
    lock = open(f'{SYNC}/sync.lock', 'w')
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)  # released by the OS when the process dies
    except BlockingIOError:
        sys.exit('already running')
    main('--dry-run' in sys.argv)
