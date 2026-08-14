import type { Executor } from './exec.js';
import { q } from './shell.js';
import type { AgentProc, PaneInfo } from './types.js';

const D = '|~|';

/** pane_title goes last: it is free-form and may contain the delimiter. */
const PANE_FMT = [
  '#{pane_id}',
  '#{pane_pid}',
  '#{pane_current_path}',
  '#{session_name}',
  '#{window_index}',
  '#{pane_index}',
  '#{pane_current_command}',
  '#{pane_title}',
].join(D);

interface PsRow {
  pid: number;
  ppid: number;
  etimes: number;
  comm: string;
}

export interface Probe {
  /** Remote wall clock, so process start times and file birth times share a clock. */
  now: number;
  home: string;
  panes: PaneInfo[];
  ps: PsRow[];
}

/**
 * One round trip for everything cheap: remote clock, home dir, panes, process table.
 * Keeping this to a single command matters over SSH, where each call costs a round trip.
 */
export async function probe(exec: Executor): Promise<Probe> {
  const script = [
    'echo "###NOW"',
    'date +%s',
    'echo "###HOME"',
    'echo "$HOME"',
    'echo "###PANES"',
    `tmux list-panes -a -F ${q(PANE_FMT)} 2>/dev/null || true`,
    'echo "###PS"',
    'ps -eo pid=,ppid=,etimes=,comm=',
  ].join('\n');

  const { stdout } = await exec.runShell(script);
  const sections = splitSections(stdout);

  const now = Number((sections.NOW ?? '').trim()) || Math.floor(Date.now() / 1000);
  const home = (sections.HOME ?? '').trim();

  const panes: PaneInfo[] = [];
  for (const line of (sections.PANES ?? '').split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split(D);
    if (parts.length < 8) continue;
    panes.push({
      paneId: parts[0]!,
      panePid: Number(parts[1]),
      cwd: parts[2]!,
      tmuxSession: parts[3]!,
      windowIndex: parts[4]!,
      paneIndex: parts[5]!,
      currentCommand: parts[6]!,
      // Rejoin: a title containing the delimiter would otherwise be truncated.
      title: parts.slice(7).join(D),
    });
  }

  const ps: PsRow[] = [];
  for (const line of (sections.PS ?? '').split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    ps.push({ pid: Number(m[1]), ppid: Number(m[2]), etimes: Number(m[3]), comm: m[4]!.trim() });
  }

  return { now, home, panes, ps };
}

function splitSections(stdout: string): Record<string, string> {
  const out: Record<string, string> = {};
  let current: string | null = null;
  const buf: string[] = [];
  const flush = () => {
    if (current) out[current] = buf.join('\n');
    buf.length = 0;
  };
  for (const line of stdout.split('\n')) {
    if (line.startsWith('###')) {
      flush();
      current = line.slice(3).trim();
    } else if (current) {
      buf.push(line);
    }
  }
  flush();
  return out;
}

/**
 * Find an agent process belonging to a pane, given the process names that count.
 *
 * The agent is normally a direct child of the pane's shell, but wrappers
 * (`zsh -lc claude`, a `script` wrapper) can add a level or two, so descend a
 * bounded depth. Both providers turn up in both shapes: sessions this app creates
 * run `zsh -lc <agent>` and the shell *exec's* into the agent, so the pane's own
 * process is the agent and there is no child to find; a session started by hand at
 * an interactive prompt is a child instead.
 */
export function findAgentInPane(
  pane: PaneInfo,
  ps: readonly PsRow[],
  comms: readonly string[],
  maxDepth = 3,
): PsRow | null {
  const wanted = new Set(comms);

  const self = ps.find((row) => row.pid === pane.panePid);
  if (self && wanted.has(self.comm)) return self;

  const byParent = new Map<number, PsRow[]>();
  for (const row of ps) {
    const list = byParent.get(row.ppid);
    if (list) list.push(row);
    else byParent.set(row.ppid, [row]);
  }

  let frontier = [pane.panePid];
  for (let depth = 0; depth < maxDepth; depth++) {
    const next: number[] = [];
    for (const pid of frontier) {
      for (const child of byParent.get(pid) ?? []) {
        if (wanted.has(child.comm)) return child;
        next.push(child.pid);
      }
    }
    if (next.length === 0) break;
    frontier = next;
  }
  return null;
}

/**
 * Confirm each candidate process really belongs to the pane we think it does, read
 * its working directory, and — when asked — which of its open files match a pattern.
 *
 * Both agents export TMUX_PANE, which is authoritative and far better than trusting
 * the process-tree walk alone.
 *
 * `fdMatch` is what makes Codex exact: it holds its own rollout transcript open, so
 * one `ls -l /proc/<pid>/fd` names the session's file outright. Folded into this same
 * script rather than a follow-up call, because over SSH each command is a round trip.
 */
export async function enrichAgentProcs(
  exec: Executor,
  pids: readonly number[],
  now: number,
  etimesByPid: ReadonlyMap<number, number>,
  fdMatch?: string,
): Promise<AgentProc[]> {
  if (pids.length === 0) return [];

  const script = pids
    .map((pid) => {
      const parts = [
        `echo "###P${pid}"`,
        `readlink /proc/${pid}/cwd 2>/dev/null`,
        `tr '\\0' '\\n' < /proc/${pid}/environ 2>/dev/null | grep '^TMUX_PANE=' || true`,
      ];
      if (fdMatch) {
        // Only the link targets, one per line, prefixed so they cannot be confused
        // with the cwd line above.
        parts.push(
          `for f in /proc/${pid}/fd/*; do t=$(readlink "$f" 2>/dev/null); ` +
            `case "$t" in *${fdMatch}*) echo "FD=$t";; esac; done 2>/dev/null || true`,
        );
      }
      return parts.join('; ');
    })
    .join('\n');

  const { stdout } = await exec.runShell(script, { timeoutMs: 20_000 });
  const sections = splitSections(stdout);

  const out: AgentProc[] = [];
  for (const pid of pids) {
    const body = sections[`P${pid}`];
    if (!body) continue;
    const lines = body.split('\n').filter((l) => l.trim());
    const cwd = lines.find((l) => l.startsWith('/')) ?? '';
    const paneLine = lines.find((l) => l.startsWith('TMUX_PANE='));
    if (!cwd || !paneLine) continue;
    const etimes = etimesByPid.get(pid) ?? 0;
    out.push({
      pid,
      startEpoch: now - etimes,
      paneId: paneLine.slice('TMUX_PANE='.length).trim(),
      cwd,
      openFiles: lines.filter((l) => l.startsWith('FD=')).map((l) => l.slice(3)),
    });
  }
  return out;
}
