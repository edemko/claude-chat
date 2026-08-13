export interface ServerConfig {
  id: string;
  label: string;
  kind: 'local' | 'ssh';
  /** ssh only: hostname or ~/.ssh/config alias. */
  host?: string;
}

/** A tmux pane as reported by `tmux list-panes`. */
export interface PaneInfo {
  paneId: string;          // stable `%N` id — always address panes by this
  panePid: number;         // the pane's shell, not the claude process
  cwd: string;
  title: string;
  tmuxSession: string;
  windowIndex: string;
  paneIndex: string;
  currentCommand: string;
}

/** A `claude` process located inside a pane. */
export interface ClaudeProc {
  pid: number;
  startEpoch: number;      // seconds since epoch, derived from `ps -o etimes`
  paneId: string;          // from the process's own TMUX_PANE
  cwd: string;             // from /proc/<pid>/cwd
}

export type SessionStatus = 'working' | 'idle' | 'unknown';

/** How confidently the transcript was matched to the pane. */
/** `pending`: the pane is running claude but has written no transcript yet. */
export type MatchConfidence = 'exact' | 'strong' | 'weak' | 'pending';

export interface SessionInfo {
  serverId: string;
  uuid: string;
  transcript: string;
  paneId: string;
  tmuxSession: string;
  pid: number;
  cwd: string;
  title: string;
  status: SessionStatus;
  confidence: MatchConfidence;
  lastActivity: number | null;   // epoch ms of transcript mtime
  lastMessage: string | null;
  /** null when the session predates this app and its launch flags are unknown. */
  skipPermissions: boolean | null;
}

export type ChatEvent =
  | { kind: 'user'; id: string; ts: number; text: string }
  | { kind: 'assistant'; id: string; ts: number; text: string }
  | { kind: 'tool'; id: string; ts: number; name: string; summary: string; input: unknown }
  | { kind: 'tool_result'; id: string; ts: number; toolUseId: string; ok: boolean; preview: string }
  | { kind: 'title'; id: string; ts: number; title: string; custom: boolean }
  | { kind: 'system'; id: string; ts: number; text: string };

export type WsMessage =
  | { type: 'events'; sessionUuid: string; events: ChatEvent[] }
  | { type: 'sessions'; sessions: SessionInfo[] }
  | { type: 'error'; message: string };
