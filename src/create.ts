/**
 * Launching a session in tmux.
 *
 * The dance is the same for both agents — start a detached session, wait for the
 * agent process to actually appear, answer the directory-trust prompt, wait for the
 * TUI to accept input — and only the strings differ. Both ask about trusting a
 * directory on first use, both block startup until answered, and for both the bypass
 * flag does *not* skip that prompt. A session created from a phone would otherwise
 * hang forever on a question nobody is looking at.
 */

import { REPO_ROOTS } from './config.js';
import type { Executor } from './exec.js';
import { enrichAgentProcs, findAgentInPane, probe } from './proc.js';
import { q } from './shell.js';
import type { AgentProc } from './types.js';

export const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** tmux session names cannot contain `.` or `:`. */
export function tmuxSafeName(dir: string, suffix: string): string {
  const base = (dir.split('/').filter(Boolean).pop() ?? 'session')
    .replace(/[^a-zA-Z0-9_-]/g, '-')
    .slice(0, 24);
  const prefixed = base.startsWith('cc-') ? base : `cc-${base}`;
  return `${prefixed}-${suffix.slice(0, 4)}`;
}

export interface StartupResult {
  /** False for a fresh session: the transcript only appears on the first message. */
  transcriptReady: boolean;
  /** The TUI is drawn and accepting input. */
  ready: boolean;
  trustPromptAnswered: boolean;
}

export interface LaunchSpec {
  dir: string;
  /** tmux session name. */
  name: string;
  /** The command line, run through a login shell. */
  inner: string;
  /** Matches the directory-trust question this agent asks. */
  trustPrompt: RegExp;
  /** Matches the drawn, input-accepting TUI. */
  readyHint: RegExp;
  /** `comm` names that identify this agent's process. */
  comms: readonly string[];
  /** Only needed when the agent holds its transcript open. */
  fdMatch?: string;
}

/**
 * Wait for the session to be usable, answering the trust prompt if it appears.
 *
 * Answering yes is safe here only because the directory came from the user's own
 * picker on their own machine — this never answers a prompt it was not shown, and
 * never guesses at one it does not recognise.
 *
 * `transcriptExists` is a callback rather than a path: Claude Code's transcript path
 * is known in advance (we pass `--session-id`), while Codex's is only discoverable
 * once the process is up, so the two answer "has it written anything yet?"
 * differently.
 */
export async function settleStartup(
  exec: Executor,
  paneId: string,
  spec: Pick<LaunchSpec, 'trustPrompt' | 'readyHint'>,
  transcriptExists: () => Promise<boolean>,
  timeoutMs = 25_000,
): Promise<StartupResult> {
  const deadline = Date.now() + timeoutMs;
  let trustPromptAnswered = false;

  while (Date.now() < deadline) {
    if (await transcriptExists()) {
      return { transcriptReady: true, ready: true, trustPromptAnswered };
    }

    const { stdout } = await exec.runShell(
      `tmux capture-pane -p -t ${q(paneId)} 2>/dev/null || true`,
    );

    if (spec.trustPrompt.test(stdout)) {
      if (!trustPromptAnswered) {
        // Option 1 is the affirmative in both agents' pickers.
        await exec.run(['tmux', 'send-keys', '-t', paneId, '1']);
        await delay(150);
        await exec.run(['tmux', 'send-keys', '-t', paneId, 'Enter']);
        trustPromptAnswered = true;
      }
    } else if (spec.readyHint.test(stdout)) {
      // Waiting for a transcript here would always time out — both agents write one
      // when the first message arrives, not at startup.
      return { transcriptReady: false, ready: true, trustPromptAnswered };
    }
    await delay(700);
  }
  return { transcriptReady: false, ready: false, trustPromptAnswered };
}

export interface Launched {
  paneId: string | null;
  proc: AgentProc | null;
  home: string;
}

/**
 * Start the session and wait for its process to exist.
 *
 * `tmux new-session` returns as soon as the pane's shell is forked, so an immediate
 * probe finds only zsh. Returning then left the new session invisible to discovery
 * and therefore unreachable by `send` — so this polls until the agent itself is
 * visible, which is also when its pane id and cwd become trustworthy.
 */
export async function launchInTmux(exec: Executor, spec: LaunchSpec): Promise<Launched> {
  const check = await exec.run(['test', '-d', spec.dir]);
  if (check.code !== 0) throw new Error(`not a directory: ${spec.dir}`);

  // A login shell is required: both agents are installed per-user and are not on a
  // non-interactive PATH.
  const res = await exec.run([
    'tmux', 'new-session', '-d', '-s', spec.name, '-c', spec.dir, `zsh -lc ${q(spec.inner)}`,
  ]);
  if (res.code !== 0) {
    throw new Error(`tmux new-session failed: ${res.stderr.trim() || res.stdout.trim()}`);
  }

  let paneId: string | null = null;
  let home = '';
  for (let attempt = 0; attempt < 24; attempt += 1) {
    const p = await probe(exec);
    home = p.home;
    const pane = p.panes.find((x) => x.tmuxSession === spec.name);
    if (pane) {
      paneId ??= pane.paneId;
      const agent = findAgentInPane(pane, p.ps, spec.comms);
      if (agent) {
        const etimes = new Map(p.ps.map((r) => [r.pid, r.etimes]));
        const [proc] = await enrichAgentProcs(exec, [agent.pid], p.now, etimes, spec.fdMatch);
        if (proc) return { paneId: proc.paneId, proc, home };
      }
    }
    await delay(500);
  }
  return { paneId, proc: null, home };
}

/** Git repos under the configured roots, for the create sheet's directory picker. */
export async function listRepoDirs(exec: Executor, home: string): Promise<string[]> {
  const roots = REPO_ROOTS.map((r) => (r.startsWith('~') ? `${home}${r.slice(1)}` : r));
  const cmd = roots
    .map((r) => `find ${q(r)} -maxdepth 2 -name .git -type d 2>/dev/null`)
    .join('; ');
  const { stdout } = await exec.runShell(cmd);
  const dirs = stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.replace(/\/\.git$/, ''));
  return [...new Set(dirs)].sort();
}
