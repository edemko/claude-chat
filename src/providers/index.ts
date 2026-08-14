/**
 * Providers: which agent a session is running.
 *
 * This is a different axis from `Executor`, and they compose. `Executor` answers
 * *where* a command runs — this machine, or another over SSH. `Provider` answers
 * *which agent* is being talked to. Any of local/ssh × claude/codex is valid, and
 * neither layer knows about the other.
 *
 * What lives behind this interface is exactly what differs. Everything the two
 * providers genuinely share — tmux plumbing, byte-window transcript reads, the
 * streaming tail, the HTTP layer, both clients — is shared code and takes no notice
 * of which provider produced a session.
 */

import type { Executor } from '../exec.js';
import type { Probe } from '../proc.js';
import type {
  ChatEvent,
  CreateResult,
  ProviderId,
  SessionDetail,
  SessionInfo,
} from '../types.js';
import type { CommandCatalogue } from '../commands.js';
import { claudeProvider } from './claude.js';
import { codexProvider } from './codex.js';

export interface Provider {
  readonly id: ProviderId;
  /** Shown in the UI. Lowercase: it sits in a badge, not a sentence. */
  readonly label: string;
  /**
   * `comm` values that mean this provider is running in a pane. Claude Code is
   * node-based and may report either name depending on how it was launched; Codex is
   * a single Rust binary.
   */
  readonly comms: readonly string[];
  /**
   * tmux key that clears the composer without leaving the session.
   *
   * Not cosmetic: `Escape` clears Claude Code's prompt, but in Codex it does nothing
   * to the text — a stale line then silently prefixes the next thing you send.
   */
  readonly clearKey: string;

  /** Is this agent installed on the machine? Cached by the caller. */
  available(exec: Executor, home: string): Promise<boolean>;

  /** Live sessions, from a probe both providers share. */
  discover(exec: Executor, serverId: string, probe: Probe): Promise<SessionInfo[]>;

  /** One transcript record to zero or more chat events. */
  toEvents(rec: Record<string, unknown>): ChatEvent[];

  /** The ⓘ sheet. */
  detail(exec: Executor, session: SessionInfo): Promise<SessionDetail>;

  /** Start a session in `dir`. `bypass` skips approval prompts. */
  create(
    exec: Executor,
    serverId: string,
    dir: string,
    bypass: boolean,
  ): Promise<CreateResult>;

  /** Slash commands this agent accepts, for the composer's autocomplete. */
  commands(exec: Executor, home: string, cwd: string | null): Promise<CommandCatalogue>;
}

const REGISTRY: Record<ProviderId, Provider> = {
  claude: claudeProvider,
  codex: codexProvider,
};

export const PROVIDERS: readonly Provider[] = [claudeProvider, codexProvider];

export function providerFor(id: string): Provider {
  const found = REGISTRY[id as ProviderId];
  if (!found) throw new Error(`unknown provider: ${id}`);
  return found;
}

export function isProviderId(id: string): id is ProviderId {
  return id in REGISTRY;
}

/**
 * Which providers this machine can actually run.
 *
 * Cached for the life of the process and per server: installing an agent is not
 * something that happens mid-session, and the UI asks on every create sheet. This is
 * what keeps the client from offering Codex on a machine that has never heard of it.
 */
const availability = new Map<string, ProviderId[]>();

export async function availableProviders(
  exec: Executor,
  home: string,
): Promise<ProviderId[]> {
  const cached = availability.get(exec.id);
  if (cached) return cached;

  const found: ProviderId[] = [];
  await Promise.all(
    PROVIDERS.map(async (p) => {
      try {
        if (await p.available(exec, home)) found.push(p.id);
      } catch {
        // Treated as absent: a probe that errors must not offer a broken option.
      }
    }),
  );
  // Registry order, not completion order, so the list is stable between calls.
  const ordered = PROVIDERS.filter((p) => found.includes(p.id)).map((p) => p.id);
  availability.set(exec.id, ordered);
  return ordered;
}
