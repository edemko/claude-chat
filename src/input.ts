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
  const { stdout, code } = await exec.run([
    'tmux', 'display-message', '-p', '-t', paneId, '#{pane_current_command}',
  ]);
  if (code !== 0) throw new Error(`pane ${paneId} no longer exists`);
  const cmd = stdout.trim();
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

/** Current visible screen, for the raw-peek view and for debugging a bad mapping. */
export async function capturePane(exec: Executor, paneId: string, lines = 120): Promise<string> {
  const { stdout } = await exec.runShell(
    `tmux capture-pane -p -S -${lines} -t ${q(paneId)} 2>/dev/null || true`,
  );
  return stdout;
}
