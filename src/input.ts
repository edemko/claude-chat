import type { Executor } from './exec.js';
import { q } from './shell.js';

/** Gap between text and Enter. Without it the TUI submits before ingesting the text. */
const SUBMIT_DELAY_MS = 90;

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Keys the client may send, mapped to tmux key names. Whitelisted, never passed through. */
const KEY_MAP: Record<string, string> = {
  escape: 'Escape',
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
      `pane ${paneId} is running "${command}", not claude — refusing to send. ` +
        `The session likely exited; text would be executed as a shell command.`,
    );
    this.name = 'PaneNotClaudeError';
  }
}

/**
 * Refuse to type into a pane whose Claude session has exited. Otherwise the message
 * would land in a shell prompt and run as a command — on a box running live services.
 */
async function assertClaudePane(exec: Executor, paneId: string): Promise<void> {
  const { stdout, code } = await exec.run([
    'tmux', 'display-message', '-p', '-t', paneId, '#{pane_current_command}',
  ]);
  if (code !== 0) throw new Error(`pane ${paneId} no longer exists`);
  const cmd = stdout.trim();
  // Depending on how it was launched, claude may report as `claude` or `node`.
  if (cmd !== 'claude' && cmd !== 'node') throw new PaneNotClaudeError(paneId, cmd);
}

export async function sendText(exec: Executor, paneId: string, text: string): Promise<void> {
  if (!text) return;
  await assertClaudePane(exec, paneId);

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

export async function sendKey(exec: Executor, paneId: string, key: string): Promise<void> {
  const tmuxKey = KEY_MAP[key.toLowerCase()];
  if (!tmuxKey) throw new Error(`unsupported key: ${key}`);
  await assertClaudePane(exec, paneId);
  await exec.run(['tmux', 'send-keys', '-t', paneId, tmuxKey]);
}

/** Current visible screen, for the raw-peek view and for debugging a bad mapping. */
export async function capturePane(exec: Executor, paneId: string, lines = 120): Promise<string> {
  const { stdout } = await exec.runShell(
    `tmux capture-pane -p -S -${lines} -t ${q(paneId)} 2>/dev/null || true`,
  );
  return stdout;
}
