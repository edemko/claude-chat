/**
 * The Codex provider.
 *
 * Structurally the easy one, for a single reason: **a running Codex holds its own
 * transcript open.** One `readlink /proc/<pid>/fd/*` names the session's rollout file
 * outright, and the same process carries `TMUX_PANE`, so pane→session is a lookup
 * rather than the inference `claude.ts` is mostly made of. There is no confidence
 * ladder here, no birth-time correlation, no screen matching and no manual picker —
 * a Codex session is either `exact` or, before its first message, `pending`.
 *
 * Codex also keeps a SQLite index at `~/.codex/state_*.sqlite` whose `threads` table
 * holds title, model, branch and token counts. This provider deliberately does not
 * read it:
 *
 *   - it would add a `sqlite3` dependency on every machine, and on this host sqlite3
 *     is only on PATH because an Android SDK happens to be installed;
 *   - the DB is in WAL mode and being written by a live process, so a plain read can
 *     see stale data without also reading the `-wal`;
 *   - everything needed is in the rollout file anyway, reachable with the same shell
 *     primitives the rest of this app already uses over SSH.
 */

import { listCommands, type CommandCatalogue, type SlashCommand } from '../commands.js';
import { launchInTmux, resolveBinary, settleStartup, tmuxSafeName } from '../create.js';
import type { Executor } from '../exec.js';
import { enrichAgentProcs, findAgentInPane, type Probe } from '../proc.js';
import { q } from '../shell.js';
import { readRecords, statFile } from '../transcript.js';
import type {
  ChatEvent,
  CreateResult,
  PaneInfo,
  SessionDetail,
  SessionInfo,
} from '../types.js';
import type { Provider } from './index.js';

const COMMS = ['codex'] as const;

/** Enough of the path to identify a rollout among a process's open files. */
const FD_MATCH = '.codex/sessions/';

/** Rollout modified this recently means the session is mid-turn. */
const WORKING_WINDOW_MS = 15_000;

/**
 * `rollout-2026-08-14T11-10-14-019fff89-482a-7fd0-a7c8-3381a4cd96fd.jsonl`
 *
 * The filename carries both a timestamp and the session id; only the id is wanted,
 * and it is the trailing UUID rather than anything positional.
 */
const ROLLOUT_UUID =
  /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

export function uuidFromRollout(path: string): string | null {
  return ROLLOUT_UUID.exec(path)?.[1]?.toLowerCase() ?? null;
}

/** Matches `claude.ts`'s scheme so a pending session has one id shape app-wide. */
function pendingId(paneId: string): string {
  return `pane-${paneId.replace('%', '')}`;
}

/* ---------- records to chat events ---------- */

/**
 * Any text carried by a content block.
 *
 * Block types are not consistently cased — a `UserMessage` holds `{type:"text"}` and
 * an `AgentMessage` holds `{type:"Text"}` — so this takes any block with a string
 * `text` rather than matching on the discriminator, which silently dropped every
 * agent message the first time round.
 */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === 'object') {
      const t = (block as { text?: unknown }).text;
      if (typeof t === 'string' && t) parts.push(t);
    }
  }
  return parts.join('\n');
}

function oneLine(s: string, max = 100): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** `["/usr/bin/zsh","-lc","git status"]` reads better as just the command. */
function commandLabel(item: Record<string, unknown>): string {
  const parsed = item['parsed_cmd'];
  if (Array.isArray(parsed)) {
    const first = parsed[0];
    if (first && typeof first === 'object') {
      const cmd = (first as { cmd?: unknown }).cmd;
      if (typeof cmd === 'string' && cmd) return oneLine(cmd);
    }
  }
  const argv = item['command'];
  if (Array.isArray(argv)) {
    // Drop the `zsh -lc` wrapper Codex runs everything through.
    const strings = argv.filter((a): a is string => typeof a === 'string');
    const at = strings.indexOf('-lc');
    const rest = at >= 0 ? strings.slice(at + 1) : strings;
    return oneLine(rest.join(' '));
  }
  return '';
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * One rollout record to zero or more chat events.
 *
 * `event_msg/item_completed` is the stream to read: it is already the sequence of UI
 * items the TUI itself renders. The parallel `response_item` records carry the same
 * content in raw API form, including developer prompts and an `<environment_context>`
 * block — reading those would mean reproducing Claude Code's isMeta/system-reminder
 * filtering for no gain.
 *
 * `CommandExecution` is the nice surprise: the call and its result arrive in one
 * record, with `status`, `exit_code` and `stdout` together. Claude Code needs a map
 * to pair a `tool_use` with a `tool_result` that may arrive either side of it; here
 * the chip and its output are emitted as a pair from a single line.
 */
export function recordToEvents(rec: Record<string, unknown>): ChatEvent[] {
  if (rec['type'] !== 'event_msg') return [];
  const payload = rec['payload'];
  if (!payload || typeof payload !== 'object') return [];
  const p = payload as Record<string, unknown>;
  if (p['type'] !== 'item_completed') return [];
  const item = p['item'];
  if (!item || typeof item !== 'object') return [];
  const it = item as Record<string, unknown>;

  const ts =
    num(p['completed_at_ms']) ??
    num(p['started_at_ms']) ??
    (typeof rec['timestamp'] === 'string' ? Date.parse(rec['timestamp']) : 0);
  const id = typeof it['id'] === 'string' && it['id'] ? it['id'] : `codex-${ts}`;
  const kind = typeof it['type'] === 'string' ? it['type'] : '';

  switch (kind) {
    case 'UserMessage': {
      const text = textOf(it['content']).trim();
      return text ? [{ kind: 'user', id, ts, text }] : [];
    }
    case 'AgentMessage': {
      const text = textOf(it['content']).trim();
      return text ? [{ kind: 'assistant', id, ts, text }] : [];
    }
    case 'Reasoning':
      /*
       * Always dropped. For Claude Code this is a presentation choice; here it is
       * also the only correct one — these items arrive with `summary_text` and
       * `raw_content` both empty, so rendering them yields a run of blank bubbles.
       */
      return [];
    case 'CommandExecution': {
      const label = commandLabel(it);
      const out = it['aggregated_output'] ?? it['formatted_output'] ?? it['stdout'];
      const exit = num(it['exit_code']);
      const events: ChatEvent[] = [
        { kind: 'tool', id, ts, name: 'shell', summary: label, input: it['command'] },
      ];
      // `status` can be running/aborted, in which case there is no exit code yet.
      if (it['status'] === 'completed' || exit !== null || typeof out === 'string') {
        events.push({
          kind: 'tool_result',
          id: `${id}-r`,
          ts,
          toolUseId: id,
          ok: exit === null ? it['status'] === 'completed' : exit === 0,
          preview: oneLine(typeof out === 'string' ? out : '', 400),
        });
      }
      return events;
    }
    case 'FileChange': {
      /*
       * `changes` is an object *keyed by absolute path*, each value holding a kind and
       * a unified diff — not the array of records the shape suggests. Read as an array
       * it stringified to raw JSON, so every edit chip in the thread was labelled with
       * a fragment of its own diff.
       */
      const changes = it['changes'];
      const paths =
        changes && typeof changes === 'object' && !Array.isArray(changes)
          ? Object.keys(changes as Record<string, unknown>)
          : [];
      // Filenames, not full paths: the repo is already the group heading in the list,
      // and a chip is one line wide.
      const names = paths.map((f) => f.split('/').pop() || f);
      const summary =
        names.length === 0
          ? oneLine(JSON.stringify(changes ?? {}), 80)
          : names.length <= 3
            ? names.join(', ')
            : `${names.slice(0, 3).join(', ')} +${names.length - 3} more`;

      const failed = it['status'] === 'failed' || Boolean(it['stderr']);
      return [
        { kind: 'tool', id, ts, name: 'edit', summary, input: changes },
        {
          kind: 'tool_result',
          id: `${id}-r`,
          ts,
          toolUseId: id,
          ok: !failed,
          // The diffs are the useful output, and they are already in the record.
          preview: oneLine(
            paths
              .map((path) => {
                const change = (changes as Record<string, unknown>)[path];
                const diff =
                  change && typeof change === 'object'
                    ? (change as { unified_diff?: unknown }).unified_diff
                    : null;
                return `${path}\n${typeof diff === 'string' ? diff : ''}`;
              })
              .join('\n\n') || String(it['stderr'] ?? ''),
            600,
          ),
        },
      ];
    }
    case 'Extension': {
      // Web search and other built-in extensions. `kind` names which one.
      const extKind = typeof it['kind'] === 'string' ? it['kind'] : 'extension';
      const query = typeof it['query'] === 'string' ? it['query'] : '';
      return [{ kind: 'tool', id, ts, name: extKind, summary: oneLine(query), input: it }];
    }
    case 'McpToolCall': {
      const tool = [it['server'], it['tool']].filter((x) => typeof x === 'string').join('/');
      return [
        { kind: 'tool', id, ts, name: tool || 'mcp', summary: oneLine(JSON.stringify(it['arguments'] ?? {}), 80), input: it['arguments'] },
      ];
    }
    default:
      /*
       * Unknown item types become chips rather than vanishing. Codex's set is
       * open-ended and grows between releases; a chip labelled with the raw kind is
       * honest and visible, where silently dropping it makes the transcript look
       * like it is missing steps.
       */
      if (!kind) return [];
      return [{ kind: 'tool', id, ts, name: kind, summary: '', input: it }];
  }
}

/* ---------- discovery ---------- */

interface Found {
  pane: PaneInfo;
  pid: number;
  paneId: string;
  cwd: string;
  transcript: string;
}

/**
 * First user message and last activity for each rollout, in one round trip.
 *
 * The first user message is what Codex itself uses as a session title, and it is not
 * reachable by reading the head of the file: the opening `session_meta` record embeds
 * the full system prompt and runs to ~18 KB on its own, putting the first message
 * past byte 62000 in a real session. `grep -m1` walks the file in C and stops at the
 * first hit, which is both correct and cheaper than any windowed read.
 */
async function readTitles(
  exec: Executor,
  paths: readonly string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (paths.length === 0) return out;

  const script = paths
    .map(
      (p, i) =>
        `printf '\\n###T${i}\\n'; ` +
        `LC_ALL=C grep -m1 -ao '"type":"UserMessage"[^]]\\{0,600\\}' ${q(p)} 2>/dev/null || true`,
    )
    .join('\n');
  const { stdout } = await exec.runShell(script, { timeoutMs: 25_000 });

  const sections = new Map<string, string>();
  let key = '';
  const buf: string[] = [];
  const flush = () => {
    if (key) sections.set(key, buf.join('\n'));
    buf.length = 0;
  };
  for (const line of stdout.split('\n')) {
    if (line.startsWith('###T')) {
      flush();
      key = line.slice(4).trim();
    } else buf.push(line);
  }
  flush();

  paths.forEach((path, i) => {
    const blob = sections.get(String(i)) ?? '';
    /*
     * The grep window ends mid-JSON, so the text is recovered by pattern rather than
     * by parsing — and deliberately without requiring a closing quote. Insisting on
     * one matched nothing at all: the window is cut in the middle of the very string
     * being read, so the value is always unterminated on a message of any length.
     * The greedy run stops at the next unescaped quote, or at the end of the window.
     */
    const m = /"text":"((?:[^"\\]|\\.)*)/.exec(blob);
    if (!m?.[1]) return;
    let text = m[1];
    try {
      text = JSON.parse(`"${m[1]}"`) as string;
    } catch {
      // Truncated escape at the window edge; the raw form is still readable.
    }
    out.set(path, text);
  });
  return out;
}

/**
 * Codex titles need shortening in a way Claude Code's do not.
 *
 * Claude Code generates a short `ai-title`. Codex uses the first user message
 * verbatim — a real one in this repo's history is 900 characters of feature brief —
 * so the list would show a wall of text where a name belongs. First sentence or
 * first line, whichever is shorter, then a hard cap.
 */
export function titleFromFirstMessage(text: string, fallback: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (!flat) return fallback;
  const stop = flat.search(/[.!?](\s|$)/);
  const firstSentence = stop > 0 ? flat.slice(0, stop) : flat;
  const candidate = firstSentence.length >= 12 ? firstSentence : flat;
  return candidate.length > 72 ? `${candidate.slice(0, 71)}…` : candidate;
}

async function discover(exec: Executor, serverId: string, p: Probe): Promise<SessionInfo[]> {
  const etimesByPid = new Map(p.ps.map((r) => [r.pid, r.etimes]));

  const paneByPid = new Map<number, PaneInfo>();
  for (const pane of p.panes) {
    const agent = findAgentInPane(pane, p.ps, COMMS);
    if (agent) paneByPid.set(agent.pid, pane);
  }
  if (paneByPid.size === 0) return [];

  // The fd read is what makes this exact; it rides along in the same round trip.
  const procs = await enrichAgentProcs(
    exec,
    [...paneByPid.keys()],
    p.now,
    etimesByPid,
    FD_MATCH,
  );

  const found: Found[] = [];
  for (const proc of procs) {
    const pane = p.panes.find((x) => x.paneId === proc.paneId) ?? paneByPid.get(proc.pid);
    if (!pane) continue;
    // A session that has not been spoken to yet has no rollout open at all.
    const transcript = proc.openFiles.find((f) => ROLLOUT_UUID.test(f)) ?? '';
    found.push({ pane, pid: proc.pid, paneId: proc.paneId, cwd: proc.cwd, transcript });
  }

  const withTranscript = found.filter((f) => f.transcript);
  const titles = await readTitles(exec, withTranscript.map((f) => f.transcript));

  const sessions: SessionInfo[] = [];
  for (const f of found) {
    const repo = f.cwd.split('/').filter(Boolean).pop() ?? 'session';
    let title = repo;
    let lastActivity: number | null = null;
    let lastMessage: string | null = null;

    if (f.transcript) {
      const first = titles.get(f.transcript);
      if (first) title = titleFromFirstMessage(first, repo);
      try {
        const records = await readRecords(exec, f.transcript, 60_000);
        for (const rec of records) {
          for (const ev of recordToEvents(rec)) {
            if (ev.ts > (lastActivity ?? 0)) lastActivity = ev.ts;
            if (ev.kind === 'assistant' || ev.kind === 'user') lastMessage = ev.text;
          }
        }
        if (lastActivity === null) {
          const st = await statFile(exec, f.transcript);
          if (st) lastActivity = st.mtime * 1000;
        }
      } catch (err) {
        console.error(`[codex] summary failed for ${f.transcript}:`, err);
      }
    }

    const age = lastActivity ? Date.now() - lastActivity : Infinity;
    sessions.push({
      serverId,
      provider: 'codex',
      uuid: (f.transcript && uuidFromRollout(f.transcript)) || pendingId(f.paneId),
      transcript: f.transcript,
      paneId: f.paneId,
      tmuxSession: f.pane.tmuxSession,
      pid: f.pid,
      cwd: f.cwd,
      isRepo: false, // the orchestrator fills this in, batching the test
      title,
      status: age < WORKING_WINDOW_MS ? 'working' : 'idle',
      // No inference happened: either the process named its file, or there is none.
      confidence: f.transcript ? 'exact' : 'pending',
      lastActivity,
      lastMessage: lastMessage ? lastMessage.replace(/\s+/g, ' ').slice(0, 160) : null,
      // Read from the transcript's own turn_context in `detail`; not worth a second
      // pass over every rollout just to populate a list row.
      skipPermissions: null,
    });
  }
  return sessions;
}

/* ---------- the ⓘ sheet ---------- */

function lastOf(
  records: readonly Record<string, unknown>[],
  match: (rec: Record<string, unknown>) => boolean,
): Record<string, unknown> | null {
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const rec = records[i];
    if (rec && match(rec)) return rec;
  }
  return null;
}

const payloadOf = (rec: Record<string, unknown> | null): Record<string, unknown> =>
  rec && typeof rec['payload'] === 'object' && rec['payload'] !== null
    ? (rec['payload'] as Record<string, unknown>)
    : {};

const objAt = (obj: Record<string, unknown>, key: string): Record<string, unknown> =>
  typeof obj[key] === 'object' && obj[key] !== null ? (obj[key] as Record<string, unknown>) : {};

function fmtReset(epochSeconds: number | null): string {
  if (!epochSeconds) return '';
  const ms = epochSeconds * 1000 - Date.now();
  if (ms <= 0) return 'now';
  const hours = Math.round(ms / 3_600_000);
  if (hours < 24) return `in ${hours}h`;
  return `in ${Math.round(hours / 24)}d`;
}

async function detail(exec: Executor, session: SessionInfo): Promise<SessionDetail> {
  const hasFile = Boolean(session.transcript);
  const p = hasFile ? q(session.transcript) : '';

  // Counts, the opening record and the file size in one pass, the same batched shape
  // info.ts uses for Claude — markers printed with a leading newline because a
  // byte-capped read cuts mid-line and would otherwise swallow the next marker.
  const section = (name: string, cmd: string) => `printf '\\n###${name}\\n'; ${cmd}`;
  const script = [
    section('uptime', `ps -o etimes= -p ${session.pid > 0 ? session.pid : 0} 2>/dev/null || true`),
    section('branch', `git -C ${q(session.cwd)} branch --show-current 2>/dev/null || true`),
    ...(hasFile
      ? [
          section('size', `stat -c %s ${p} 2>/dev/null || true`),
          section('first', `head -n 1 ${p} 2>/dev/null | head -c 400 || true`),
          section('user', `LC_ALL=C grep -c '"type":"UserMessage"' ${p} 2>/dev/null || true`),
          section('assistant', `LC_ALL=C grep -c '"type":"AgentMessage"' ${p} 2>/dev/null || true`),
          section('tools', `LC_ALL=C grep -o '"type":"CommandExecution"' ${p} 2>/dev/null | wc -l || true`),
          /*
           * The last turn's context, grepped rather than read from the tail.
           *
           * `turn_context` is written once per turn, near the *start* of that turn —
           * so on a session with long turns the most recent one is far from the end of
           * the file. Measured on a real session: 684 KB back, well outside any tail
           * window worth reading. One C pass and the last match is exact, whatever
           * the turn length.
           */
          section(
            'turnctx',
            `LC_ALL=C grep -ao '"type":"turn_context".\\{0,1200\\}' ${p} 2>/dev/null | tail -1 || true`,
          ),
        ]
      : []),
  ].join('\n');

  const [{ stdout }, records] = await Promise.all([
    exec.runShell(script, { timeoutMs: 25_000 }),
    hasFile ? readRecords(exec, session.transcript, 300_000).catch(() => []) : Promise.resolve([]),
  ]);

  const parts = new Map<string, string>();
  {
    let key = '';
    const buf: string[] = [];
    const flush = () => {
      if (key) parts.set(key, buf.join('\n').trim());
      buf.length = 0;
    };
    for (const line of stdout.split('\n')) {
      if (line.startsWith('###')) {
        flush();
        key = line.slice(3).trim();
      } else buf.push(line);
    }
    flush();
  }
  const int = (name: string): number => {
    const v = Number.parseInt(parts.get(name) ?? '', 10);
    return Number.isFinite(v) ? v : 0;
  };

  /*
   * Context comes from the *last* token_count record's `last_token_usage`.
   *
   * The tempting fields are wrong: `total_token_usage` and the SQLite index's
   * `tokens_used` are both cumulative across the whole session, and on a real
   * session that meant 510639 against a 258400-token window — 198% of a context
   * that was in fact about a quarter full.
   */
  const tokenRec = payloadOf(
    lastOf(records, (r) => r['type'] === 'event_msg' && payloadOf(r)['type'] === 'token_count'),
  );
  const info = objAt(tokenRec, 'info');
  const lastUsage = objAt(info, 'last_token_usage');
  const contextTokens = num(lastUsage['total_tokens']);
  const outputTokens = num(lastUsage['output_tokens']);
  const contextWindow = num(info['model_context_window']);

  /*
   * Fields are pulled out of the grepped window by pattern, since it is cut mid-record
   * and cannot be parsed. The tail records are still consulted as a fallback: on a
   * short session the whole file is inside the window and parsing is exact.
   */
  const ctxBlob = parts.get('turnctx') ?? '';
  const field = (key: string): string | null =>
    new RegExp(`"${key}":"([^"]*)"`).exec(ctxBlob)?.[1] || null;

  const turnCtx = payloadOf(lastOf(records, (r) => r['type'] === 'turn_context'));
  const collab = objAt(turnCtx, 'collaboration_mode');
  const collabSettings = objAt(collab, 'settings');

  const model =
    field('model') ??
    (typeof turnCtx['model'] === 'string' ? turnCtx['model'] : null) ??
    (typeof collabSettings['model'] === 'string' ? collabSettings['model'] : null);
  const effort =
    field('reasoning_effort') ??
    (typeof collabSettings['reasoning_effort'] === 'string'
      ? (collabSettings['reasoning_effort'] as string)
      : null);

  const extra: { label: string; value: string }[] = [];
  // `mode` is the collaboration mode — "plan" while Codex is planning rather than
  // editing, which is worth seeing from a phone before sending it more work.
  const mode =
    /"collaboration_mode":\{"mode":"([^"]*)"/.exec(ctxBlob)?.[1] ||
    (typeof collab['mode'] === 'string' ? collab['mode'] : null);
  if (mode) extra.push({ label: 'mode', value: mode });
  const approval =
    field('approval_policy') ??
    (typeof turnCtx['approval_policy'] === 'string' ? turnCtx['approval_policy'] : null);
  if (approval) extra.push({ label: 'approvals', value: approval });
  const sandboxType =
    /"sandbox_policy":\{"type":"([^"]*)"/.exec(ctxBlob)?.[1] ||
    (typeof objAt(turnCtx, 'sandbox_policy')['type'] === 'string'
      ? (objAt(turnCtx, 'sandbox_policy')['type'] as string)
      : null);
  if (sandboxType) extra.push({ label: 'sandbox', value: sandboxType });

  /*
   * Rate limits are structured data here. Claude Code computes the equivalent inside
   * the process and hands it only to a `statusLine` command, which is why that half
   * of the ⓘ sheet is scraped off the terminal for Claude and simply read here.
   */
  const limits = objAt(tokenRec, 'rate_limits');
  for (const key of ['primary', 'secondary'] as const) {
    const window = objAt(limits, key);
    const used = num(window['used_percent']);
    if (used === null) continue;
    const minutes = num(window['window_minutes']);
    const label = minutes ? (minutes % 1440 === 0 ? `${minutes / 1440}d limit` : `${Math.round(minutes / 60)}h limit`) : 'limit';
    const resets = fmtReset(num(window['resets_at']));
    extra.push({
      label,
      value: `${Math.round(used)}% used${resets ? ` · resets ${resets}` : ''}`,
    });
  }
  const plan = typeof limits['plan_type'] === 'string' ? limits['plan_type'] : null;
  if (plan) extra.push({ label: 'plan', value: plan });

  const meta = payloadOf(lastOf(records, (r) => r['type'] === 'session_meta'));
  let version = typeof meta['cli_version'] === 'string' ? meta['cli_version'] : null;
  let startedAt: number | null = null;
  {
    const head = parts.get('first') ?? '';
    if (!version) {
      const m = /"cli_version":"([^"]+)"/.exec(head);
      if (m?.[1]) version = m[1];
    }
    const stamp = /"timestamp":"([^"]+)"/.exec(head);
    if (stamp?.[1]) {
      const ms = Date.parse(stamp[1]);
      if (Number.isFinite(ms)) startedAt = ms;
    }
  }

  const branch = parts.get('branch') ?? '';
  const size = int('size');

  return {
    // Nothing to scrape: every number Claude Code hides behind its status line is a
    // field in the rollout, and the rows below already carry them.
    statusLine: [],
    model,
    effort,
    version,
    gitBranch: branch && branch !== 'HEAD' ? branch : null,
    contextTokens,
    contextWindow,
    outputTokens,
    turns: { user: int('user'), assistant: int('assistant'), tools: int('tools') },
    startedAt,
    transcriptBytes: size > 0 ? size : null,
    uptimeSeconds: int('uptime') || null,
    extra,
  };
}

/* ---------- creating a session ---------- */

const TRUST_PROMPT = /Do you trust the contents of this directory|Yes, continue/i;
const READY_HINT = /OpenAI Codex|\/model to change|Run \/review/;

/** Where a Codex install lives when it is not on PATH. */
const CODEX_PATHS = ['"$HOME"/.local/bin/codex', '"$HOME"/.codex/packages/standalone/current/bin/codex'];

async function create(
  exec: Executor,
  _serverId: string,
  dir: string,
  bypass: boolean,
): Promise<CreateResult> {
  /*
   * The absolute path, not the bare name. Codex installs to `~/.local/bin`, which is
   * on an interactive shell's PATH via `.zshrc` and on the hub's PATH not at all — so
   * `zsh -lc codex` died with "command not found" and, because `tmux new-session -d`
   * succeeds regardless, produced a session that silently never existed.
   */
  const bin = await resolveBinary(exec, 'codex', CODEX_PATHS);
  if (!bin) {
    throw new Error(
      'codex is not installed, or its binary could not be found (looked on PATH, ' +
        'in ~/.local/bin and in ~/.codex/packages)',
    );
  }

  // No `--session-id` equivalent exists, and none is needed: the process names its
  // own rollout on an fd, so the mapping is read rather than arranged in advance.
  const name = tmuxSafeName(dir, Math.random().toString(16).slice(2, 6));
  const inner = q(bin) + (bypass ? ' --dangerously-bypass-approvals-and-sandbox' : '');

  const spec = {
    dir,
    name,
    inner,
    trustPrompt: TRUST_PROMPT,
    readyHint: READY_HINT,
    comms: COMMS,
    fdMatch: FD_MATCH,
  };
  const { paneId, proc } = await launchInTmux(exec, spec);
  const transcript = proc?.openFiles.find((f) => ROLLOUT_UUID.test(f)) ?? '';

  const startup = paneId
    ? await settleStartup(exec, paneId, spec, async () => {
        // A fresh Codex has no rollout at all until the first message, so "ready"
        // is the only thing worth waiting for here.
        if (!transcript) return false;
        return (await exec.run(['test', '-f', transcript])).code === 0;
      })
    : { transcriptReady: false, ready: false, trustPromptAnswered: false };

  return {
    uuid: (transcript && uuidFromRollout(transcript)) || pendingId(paneId ?? '%?'),
    tmuxSession: name,
    paneId,
    transcript,
    dir,
    ...startup,
  };
}

/* ---------- slash commands ---------- */

/**
 * Codex's built-ins, with the descriptions its own TUI shows.
 *
 * The same binary-scan trick used for Claude Code works here — the strings are all
 * in the executable — but Codex is a Rust binary that stores the names and the
 * descriptions in separate runs, so scanning gives a list with no reliable pairing.
 * A curated list is the honest answer; `commands.ts` still contributes this
 * machine's and this project's own commands and skills on top.
 */
const CODEX_BUILTINS: readonly [string, string, string | null][] = [
  ['model', 'Choose the model and reasoning effort', null],
  ['fast', '1.5x speed, increased usage', null],
  ['permissions', 'Choose what Codex is allowed to do', null],
  ['approve', 'Approve one retry of a recent auto-review denial', null],
  ['review', 'Review any changes and find issues', null],
  ['plan', 'Work out a detailed plan before implementing', null],
  ['compact', 'Summarise the conversation to free up context', null],
  ['new', 'Start a new session', null],
  ['clear', 'Clear the conversation', null],
  ['name', 'Name this session', '[name]'],
  ['init', 'Create an AGENTS.md for this project', null],
  ['status', 'Show session status and configuration', null],
  ['diff', 'Show the current working-tree diff', null],
  ['mention', 'Reference a file in your message', '<file>'],
  ['skills', 'List available skills', null],
  ['agents', 'Manage subagents', null],
  ['mcp', 'Manage MCP servers', null],
  ['ide', 'Pull context from your IDE', null],
  ['keymap', 'Remap TUI shortcuts', null],
  ['vim', 'Toggle Vim mode for the composer', null],
  ['experimental', 'Toggle experimental features', null],
  ['exit', 'End this session', null],
];

async function commands(
  exec: Executor,
  home: string,
  cwd: string | null,
): Promise<CommandCatalogue> {
  const builtin: SlashCommand[] = CODEX_BUILTINS.map(([name, description, argumentHint]) => ({
    name,
    description,
    argumentHint,
    source: 'builtin' as const,
    path: null,
  }));
  // Codex reads its own `~/.codex/skills` and project `.codex` directories; the
  // shared scanner is pointed at those instead of `.claude`.
  return listCommands(exec, home, cwd, { builtins: builtin, configDir: '.codex' });
}

export const codexProvider: Provider = {
  id: 'codex',
  label: 'codex',
  comms: COMMS,
  /*
   * C-u, not Escape.
   *
   * Escape does not clear Codex's composer — verified by typing into a throwaway
   * session, where three Escapes left `//n/` sitting in the box. A stale line then
   * silently prefixes whatever is sent next, which is worse than the key doing
   * nothing at all.
   */
  clearKey: 'C-u',

  /*
   * Deliberately looser than `resolveBinary`. Discovery of *existing* sessions needs
   * no binary at all, so a Codex that is present but unlocatable should still have its
   * sessions listed and read; only `create` requires the executable, and it says so
   * with its own error.
   */
  async available(exec: Executor, home: string): Promise<boolean> {
    const { code } = await exec.runShell(
      `command -v codex >/dev/null 2>&1 || [ -x ${q(`${home}/.local/bin/codex`)} ] ` +
        `|| [ -d ${q(`${home}/.codex/sessions`)} ]`,
    );
    return code === 0;
  },

  discover,
  toEvents: recordToEvents,
  detail,
  create,
  commands,
};
