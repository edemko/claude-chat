import type { Executor } from './exec.js';
import { q } from './shell.js';

/** Gap between text and Enter. Without it the TUI submits before ingesting the text. */
const SUBMIT_DELAY_MS = 90;

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Keys the client may send, mapped to tmux key names. Whitelisted, never passed through. */
const KEY_MAP: Record<string, string> = {
  escape: 'Escape',
  'ctrl-u': 'C-u',
  'ctrl-c': 'C-c',
  'ctrl-d': 'C-d',
  'ctrl-l': 'C-l',
  'ctrl-r': 'C-r',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  tab: 'Tab',
  'shift-tab': 'BTab',
  enter: 'Enter',
};

export class PaneNotClaudeError extends Error {
  constructor(readonly paneId: string, readonly command: string) {
    super(
      `pane ${paneId} is running "${command}", not an agent — refusing to send. ` +
        `The session likely exited; text would be executed as a shell command.`,
    );
    this.name = 'PaneNotClaudeError';
  }
}

/**
 * Process names a pane may be running for a send to be safe.
 *
 * Depending on how it was launched Claude Code reports as `claude` or as `node`, and
 * Codex as `codex`. The check is deliberately permissive across agents but never
 * accepts a shell: the whole point is refusing to type a message at a shell prompt,
 * where it would run as a command on a box hosting live services.
 */
const AGENT_COMMS = new Set(['claude', 'node', 'codex']);

/**
 * Refuse to type into a pane whose agent has exited.
 */
async function assertAgentPane(exec: Executor, paneId: string): Promise<void> {
  const { stdout } = await exec.run([
    'tmux', 'display-message', '-p', '-t', paneId, '#{pane_current_command}',
  ]);
  const cmd = stdout.trim();
  /*
   * Empty output means the pane is gone.
   *
   * `display-message` against a dead pane prints a blank line and exits **0**, so the
   * exit code says nothing — the "no longer exists" branch here previously could not
   * fire, and a send to a closed pane reported the nonsense `pane is running "", not
   * an agent`.
   */
  if (!cmd) throw new Error(`pane ${paneId} no longer exists`);
  if (!AGENT_COMMS.has(cmd)) throw new PaneNotClaudeError(paneId, cmd);
}

export async function sendText(exec: Executor, paneId: string, text: string): Promise<void> {
  if (!text) return;
  await assertAgentPane(exec, paneId);

  const needsPaste = text.includes('\n') || text.includes('\\');
  if (needsPaste) {
    // Bracketed paste keeps embedded newlines from submitting early, and sidesteps
    // any escape interpretation in send-keys.
    await exec.run(['tmux', 'load-buffer', '-b', 'claude-chat', '-'], { input: text });
    await exec.run(['tmux', 'paste-buffer', '-b', 'claude-chat', '-t', paneId, '-d', '-p']);
  } else {
    await exec.run(['tmux', 'send-keys', '-t', paneId, '-l', '--', text]);
  }

  await delay(SUBMIT_DELAY_MS);
  await exec.run(['tmux', 'send-keys', '-t', paneId, 'Enter']);
}

/**
 * `clear` is resolved by the caller to the provider's own key.
 *
 * Escape clears Claude Code's composer; in Codex it leaves the text alone, so a
 * stale line silently prefixes whatever is sent next. One logical key, two bindings.
 */
export async function sendKey(
  exec: Executor,
  paneId: string,
  key: string,
  clearKey?: string,
): Promise<void> {
  const lower = key.toLowerCase();
  const tmuxKey = lower === 'clear' ? clearKey : KEY_MAP[lower];
  if (!tmuxKey) throw new Error(`unsupported key: ${key}`);
  await assertAgentPane(exec, paneId);
  await exec.run(['tmux', 'send-keys', '-t', paneId, tmuxKey]);
}

/**
 * Close a session: ask the agent to exit, then close its pane.
 *
 * Asking first matters — the agent flushes its transcript and updates its own index on
 * a clean exit, and both remain resumable. Only if it is still there after a grace
 * period is the pane closed from underneath it.
 *
 * `kill-pane`, deliberately **not** `kill-session`. A tmux session often holds several
 * panes — one of this user's holds an editor alongside an agent — and ending the whole
 * session because one pane ran an agent would take unrelated work with it. tmux ends a
 * session by itself once its last pane is gone, which is exactly the wanted behaviour
 * and needs no special case.
 */
export interface CloseResult {
  /** The agent shut itself down; the pane never had to be closed from outside. */
  exitedCleanly: boolean;
  /** Final state: the pane no longer exists. This is the fact that matters. */
  paneGone: boolean;
  /** The tmux session is gone too, i.e. that pane was the last thing in it. */
  sessionGone: boolean;
}

/** Grace period for a clean exit before the pane is closed from underneath. */
const EXIT_GRACE_MS = 12_000;
const POLL_MS = 500;

export async function closeSession(
  exec: Executor,
  paneId: string,
  tmuxSession: string,
  exitCommand: string,
): Promise<CloseResult> {
  /*
   * Existence by enumeration, not by exit code.
   *
   * `tmux display-message -t <dead pane>` exits 0 and prints an empty line, so every
   * exit-code check reported a closed pane as alive — which made a close that had
   * worked perfectly report `paneGone: false`.
   */
  const paneExists = async (): Promise<boolean> => {
    const { stdout } = await exec.run(['tmux', 'list-panes', '-a', '-F', '#{pane_id}']);
    return stdout.split('\n').some((line) => line.trim() === paneId);
  };
  const sessionExists = async (): Promise<boolean> =>
    (await exec.run(['tmux', 'has-session', '-t', `=${tmuxSession}`])).code === 0;

  try {
    await sendText(exec, paneId, exitCommand);
  } catch {
    // Already gone, or no longer an agent — either way, fall through to the pane.
  }

  let exitedCleanly = false;
  for (let waited = 0; waited < EXIT_GRACE_MS; waited += POLL_MS) {
    await delay(POLL_MS);
    if (!(await paneExists())) {
      exitedCleanly = true;
      break;
    }
    const { stdout } = await exec.run([
      'tmux', 'display-message', '-p', '-t', paneId, '#{pane_current_command}',
    ]);
    // Back at a shell means the agent quit but left its pane open.
    const cmd = stdout.trim();
    if (cmd && !AGENT_COMMS.has(cmd)) {
      exitedCleanly = true;
      break;
    }
  }

  /*
   * Close the pane if it is still there, then report the *observed* end state rather
   * than what each command returned. An earlier version reported the exit codes, and
   * said `paneKilled: false, exited: false` for a close that had in fact worked
   * perfectly — `kill-pane` had simply lost a race with an agent that was already on
   * its way out.
   */
  if (await paneExists()) await exec.run(['tmux', 'kill-pane', '-t', paneId]);
  await delay(300);
  const [paneGone, sessionAlive] = await Promise.all([
    paneExists().then((alive) => !alive),
    sessionExists(),
  ]);
  return { exitedCleanly, paneGone, sessionGone: !sessionAlive };
}

/** Current visible screen, for the raw-peek view and for debugging a bad mapping. */
export async function capturePane(exec: Executor, paneId: string, lines = 120): Promise<string> {
  const { stdout } = await exec.runShell(
    `tmux capture-pane -p -S -${lines} -t ${q(paneId)} 2>/dev/null || true`,
  );
  return stdout;
}
