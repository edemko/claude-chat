import { randomUUID } from 'node:crypto';
import { REPO_ROOTS } from './config.js';
import type { Executor } from './exec.js';
import { enrichClaudeProcs, findClaudeInPane, probe } from './proc.js';
import { putMapping, recordCreated } from './registry.js';
import { q } from './shell.js';
import { projectDirFor } from './transcript.js';

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** tmux session names cannot contain `.` or `:`. */
function tmuxSafeName(dir: string, uuid: string): string {
  const base = (dir.split('/').filter(Boolean).pop() ?? 'session')
    .replace(/[^a-zA-Z0-9_-]/g, '-')
    .slice(0, 24);
  const prefixed = base.startsWith('cc-') ? base : `cc-${base}`;
  return `${prefixed}-${uuid.slice(0, 4)}`;
}

/**
 * Claude Code asks whether a directory is trusted the first time it opens one, and
 * blocks startup until answered — `--dangerously-skip-permissions` does not skip it.
 * A session created from the app would otherwise hang forever on a screen nobody is
 * looking at.
 */
const TRUST_PROMPT = /Is this a project you created or one you trust|Yes, I trust this folder/i;

/** The TUI is accepting input once the prompt box is drawn. */
const READY_HINT = /❯|for shortcuts|Try "how do I/;

export interface StartupResult {
  /** False for a fresh session: the transcript only appears on the first message. */
  transcriptReady: boolean;
  /** The TUI is drawn and accepting input. */
  ready: boolean;
  trustPromptAnswered: boolean;
}

/**
 * Wait for the session to be usable, answering the trust prompt if it appears.
 *
 * Answering yes is safe here only because the directory came from the user's own
 * picker on their own machine — this never guesses at a prompt it was not shown.
 */
async function settleStartup(
  exec: Executor,
  paneId: string,
  transcript: string,
  timeoutMs = 25_000,
): Promise<StartupResult> {
  const deadline = Date.now() + timeoutMs;
  let trustPromptAnswered = false;

  while (Date.now() < deadline) {
    if ((await exec.run(['test', '-f', transcript])).code === 0) {
      return { transcriptReady: true, ready: true, trustPromptAnswered };
    }

    const { stdout } = await exec.runShell(
      `tmux capture-pane -p -t ${q(paneId)} 2>/dev/null || true`,
    );

    if (TRUST_PROMPT.test(stdout)) {
      if (!trustPromptAnswered) {
        // Option 1 is "Yes, I trust this folder".
        await exec.run(['tmux', 'send-keys', '-t', paneId, '1']);
        await delay(150);
        await exec.run(['tmux', 'send-keys', '-t', paneId, 'Enter']);
        trustPromptAnswered = true;
      }
    } else if (READY_HINT.test(stdout)) {
      // Waiting for a transcript here would always time out — Claude Code writes it
      // when the first message arrives, not at startup.
      return { transcriptReady: false, ready: true, trustPromptAnswered };
    }
    await delay(700);
  }
  return { transcriptReady: false, ready: false, trustPromptAnswered };
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

export interface CreateResult {
  uuid: string;
  tmuxSession: string;
  paneId: string | null;
  transcript: string;
  dir: string;
  transcriptReady: boolean;
  ready: boolean;
  trustPromptAnswered: boolean;
}

/**
 * Start a new Claude session in its own detached tmux session.
 *
 * The uuid is generated here and passed via `--session-id`, so the pane→transcript
 * mapping is known exactly rather than inferred — no heuristics for anything this
 * app launches.
 */
export async function createSession(
  exec: Executor,
  serverId: string,
  dir: string,
  skipPermissions: boolean,
): Promise<CreateResult> {
  const check = await exec.run(['test', '-d', dir]);
  if (check.code !== 0) throw new Error(`not a directory: ${dir}`);

  const uuid = randomUUID();
  const name = tmuxSafeName(dir, uuid);

  const inner =
    `claude --session-id ${uuid}` + (skipPermissions ? ' --dangerously-skip-permissions' : '');

  // A login shell is required: claude comes from nvm and is not on a
  // non-interactive PATH.
  const res = await exec.run([
    'tmux', 'new-session', '-d', '-s', name, '-c', dir, `zsh -lc ${q(inner)}`,
  ]);
  if (res.code !== 0) {
    throw new Error(`tmux new-session failed: ${res.stderr.trim() || res.stdout.trim()}`);
  }

  const initial = await probe(exec);
  const transcript = `${projectDirFor(initial.home, dir)}/${uuid}.jsonl`;

  /*
   * Wait for the claude process to actually appear before registering the mapping.
   * `tmux new-session` returns as soon as the pane's shell is forked, so an immediate
   * probe finds only zsh — registering nothing, which left the new session invisible
   * to discovery and therefore unreachable by `send`.
   */
  let paneId: string | null = null;
  for (let attempt = 0; attempt < 24; attempt++) {
    const p = await probe(exec);
    const pane = p.panes.find((x) => x.tmuxSession === name);
    if (pane) {
      paneId ??= pane.paneId;
      const claude = findClaudeInPane(pane, p.ps);
      if (claude) {
        const etimes = new Map(p.ps.map((r) => [r.pid, r.etimes]));
        const [proc] = await enrichClaudeProcs(exec, [claude.pid], p.now, etimes);
        if (proc) {
          paneId = proc.paneId;
          putMapping(serverId, proc.paneId, proc.pid, { uuid, transcript, confidence: 'exact' });
          break;
        }
      }
    }
    await delay(500);
  }

  recordCreated({
    uuid,
    serverId,
    dir,
    tmuxSession: name,
    createdAt: Date.now(),
    skipPermissions,
  });

  const startup = paneId
    ? await settleStartup(exec, paneId, transcript)
    : { transcriptReady: false, ready: false, trustPromptAnswered: false };

  return { uuid, tmuxSession: name, paneId, transcript, dir, ...startup };
}
