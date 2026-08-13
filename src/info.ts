/**
 * Session detail for the "i" sheet.
 *
 * Two sources, deliberately kept apart:
 *
 * 1. The **status line** is scraped verbatim off the pane. Cost, rate-limit windows
 *    and the exact context percentage are computed by the running Claude Code process
 *    and handed only to the configured `statusLine` command — they are nowhere in the
 *    transcript, so reading the pane is the only way to show the same numbers the
 *    desktop shows. It is presentation, not data: shown as text, never parsed.
 * 2. Everything else is derived from the transcript and the process, which is
 *    mechanical and always available even when no status line is configured.
 */

import type { Executor } from './exec.js';
import { q } from './shell.js';
import { readRecords } from './transcript.js';
import type { SessionInfo } from './types.js';

export interface SessionDetail {
  /** Rendered status line as it appears in the pane, one entry per line. */
  statusLine: string[];
  model: string | null;
  effort: string | null;
  version: string | null;
  gitBranch: string | null;
  /** Tokens in the last request's context: input + cache read + cache creation. */
  contextTokens: number | null;
  outputTokens: number | null;
  turns: { user: number; assistant: number; tools: number };
  startedAt: number | null;
  transcriptBytes: number | null;
  /** Seconds the claude process has been running. */
  uptimeSeconds: number | null;
}

/** The hint line Claude Code prints under the status line. */
const HINT = /⏵⏵|shift\+tab to cycle/;
/** Box-drawing borders around the input box — the top edge of what we want. */
const BORDER = /^[\s─━╭╮╰╯│┌┐└┘]+$/u;
/** A status line is separated by middle dots; the format itself is the user's. */
const MIDDLE_DOT = '·';

/**
 * Pull the status line out of a captured screen.
 *
 * It sits at the very bottom, between the input box and the hint line, and wraps
 * onto as many rows as the pane is narrow. Anchoring on the hint line and walking
 * up beats matching any particular format — the status line is a user-supplied
 * script and may print anything.
 */
export function extractStatusLine(screen: string): string[] {
  const lines = screen.replace(/\s+$/u, '').split('\n');
  let end = lines.length;
  for (let i = lines.length - 1; i >= 0 && i >= lines.length - 6; i -= 1) {
    if (HINT.test(lines[i] ?? '')) {
      end = i;
      break;
    }
  }

  const out: string[] = [];
  for (let i = end - 1; i >= 0 && out.length < 4; i -= 1) {
    const line = (lines[i] ?? '').trim();
    if (!line) {
      if (out.length > 0) break;
      continue;
    }
    // The input box's border marks the top of the status line region.
    if (BORDER.test(line)) break;
    if (!line.includes(MIDDLE_DOT)) break;
    out.unshift(line);
  }
  return out;
}

interface Counts {
  user: number;
  assistant: number;
  tools: number;
  bytes: number | null;
  firstTs: number | null;
}

/**
 * Counting is done with grep rather than by parsing, so a 2 MB transcript costs one
 * pass in C instead of a JSON parse per line.
 */
async function countRecords(exec: Executor, path: string): Promise<Counts> {
  const p = q(path);
  // Each marker is printed with a leading newline: `head -c` cuts mid-line, and
  // without it the next marker would be appended to that partial line and the
  // section it labels would be lost.
  const section = (name: string, cmd: string) => `printf '\\n###${name}\\n'; ${cmd}`;
  const script = [
    section('size', `stat -c %s ${p} 2>/dev/null || true`),
    // The opening records — `mode`, `permission-mode` — carry no timestamp, so the
    // first few lines are scanned rather than just one. Capped, because a
    // file-history-snapshot record can be megabytes on a single line.
    section('first', `head -20 ${p} 2>/dev/null | head -c 32768 || true`),
    section('user', `grep -c '"type":"user"' ${p} 2>/dev/null || true`),
    section('assistant', `grep -c '"type":"assistant"' ${p} 2>/dev/null || true`),
    section('tools', `grep -o '"type":"tool_use"' ${p} 2>/dev/null | wc -l || true`),
  ].join('\n');
  const { stdout } = await exec.runShell(script, { timeoutMs: 25_000 });

  const parts = new Map<string, string>();
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

  const num = (name: string): number => {
    const v = Number.parseInt(parts.get(name) ?? '', 10);
    return Number.isFinite(v) ? v : 0;
  };

  // Matched rather than parsed: the window is capped and may be cut mid-record, and
  // the first timestamp in it is the session's start whichever record carries it.
  let firstTs: number | null = null;
  const stamp = /"timestamp":"([^"]+)"/.exec(parts.get('first') ?? '');
  if (stamp) {
    const ms = Date.parse(stamp[1] ?? '');
    if (Number.isFinite(ms)) firstTs = ms;
  }

  const size = num('size');
  return {
    user: num('user'),
    assistant: num('assistant'),
    tools: num('tools'),
    bytes: size > 0 ? size : null,
    firstTs,
  };
}

function str(rec: Record<string, unknown>, key: string): string | null {
  const v = rec[key];
  return typeof v === 'string' && v ? v : null;
}

/**
 * Latest model, effort, branch and context size, read from the tail of the
 * transcript. Sub-agent turns are skipped: they run their own context and would
 * report a fraction of the main conversation's.
 */
function fromRecords(records: readonly Record<string, unknown>[]): Partial<SessionDetail> {
  const out: Partial<SessionDetail> = {};
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const rec = records[i];
    if (!rec || rec['type'] !== 'assistant' || rec['isSidechain'] === true) continue;
    const message = rec['message'];
    if (typeof message !== 'object' || message === null) continue;
    const msg = message as Record<string, unknown>;

    const model = typeof msg['model'] === 'string' ? msg['model'] : null;
    // `<synthetic>` marks a message the CLI produced itself, not the model.
    if (!model || model.startsWith('<')) continue;

    out.model ??= model;
    out.effort ??= str(rec, 'effort');
    out.version ??= str(rec, 'version');
    out.gitBranch ??= str(rec, 'gitBranch');

    const usage = msg['usage'];
    if (out.contextTokens == null && typeof usage === 'object' && usage !== null) {
      const u = usage as Record<string, unknown>;
      const n = (key: string): number => (typeof u[key] === 'number' ? (u[key] as number) : 0);
      const ctx = n('input_tokens') + n('cache_read_input_tokens') + n('cache_creation_input_tokens');
      if (ctx > 0) out.contextTokens = ctx;
      const outTok = n('output_tokens');
      if (outTok > 0) out.outputTokens = outTok;
    }
    if (out.contextTokens != null) break;
  }
  return out;
}

export async function sessionDetail(
  exec: Executor,
  session: SessionInfo,
): Promise<SessionDetail> {
  // 40 rows is enough for the status line plus the hint, and cheap on a wide pane.
  const [{ stdout: screen }, counts] = await Promise.all([
    exec.runShell(`tmux capture-pane -p -S -40 -t ${q(session.paneId)} 2>/dev/null || true`),
    session.transcript
      ? countRecords(exec, session.transcript)
      : Promise.resolve<Counts>({ user: 0, assistant: 0, tools: 0, bytes: null, firstTs: null }),
  ]);

  const records = session.transcript
    ? await readRecords(exec, session.transcript, 200_000).catch(() => [])
    : [];
  const derived = fromRecords(records);

  let uptimeSeconds: number | null = null;
  let liveBranch: string | null = null;
  const { stdout: extra } = await exec.runShell(
    [
      `echo "###uptime"; ps -o etimes= -p ${session.pid > 0 ? session.pid : 0} 2>/dev/null || true`,
      `echo "###branch"; git -C ${q(session.cwd)} branch --show-current 2>/dev/null || true`,
    ].join('\n'),
  );
  {
    const uptime = /###uptime\n([^\n]*)/.exec(extra)?.[1]?.trim();
    const v = Number.parseInt(uptime ?? '', 10);
    if (Number.isFinite(v)) uptimeSeconds = v;
    const branch = /###branch\n([^\n]*)/.exec(extra)?.[1]?.trim();
    // Empty outside a repo; a literal "HEAD" means detached, which is not a branch.
    if (branch && branch !== 'HEAD') liveBranch = branch;
  }

  return {
    statusLine: extractStatusLine(screen),
    model: derived.model ?? null,
    effort: derived.effort ?? null,
    version: derived.version ?? null,
    // Live git beats the transcript's copy, which is whatever was checked out when
    // the last turn ran. Neither reports a branch outside a repo.
    gitBranch: liveBranch ?? (derived.gitBranch === 'HEAD' ? null : derived.gitBranch ?? null),
    contextTokens: derived.contextTokens ?? null,
    outputTokens: derived.outputTokens ?? null,
    turns: { user: counts.user, assistant: counts.assistant, tools: counts.tools },
    startedAt: counts.firstTs,
    transcriptBytes: counts.bytes,
    uptimeSeconds,
  };
}
