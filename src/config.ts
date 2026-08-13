import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ServerConfig } from './types.js';

export const CC_DIR = process.env.CC_DIR ?? join(homedir(), '.claude-chat');
export const REGISTRY_PATH = join(CC_DIR, 'registry.json');
const TOKEN_PATH = join(CC_DIR, 'token');
const SERVERS_PATH = join(CC_DIR, 'servers.json');

export const PORT = Number(process.env.CC_PORT ?? 7420);

/**
 * Loopback unless told otherwise, so an unconfigured hub is not reachable from
 * anywhere. Set `CC_HOST` to your Tailscale address (`tailscale ip -4`) to reach it
 * from a phone; server.ts falls back to loopback if that address is absent, which
 * fails closed rather than binding the world.
 *
 * Never set this to 0.0.0.0. Any credential here is shell-equivalent access to the
 * machine, and the bind address is the real boundary — see the README.
 */
export const HOST = process.env.CC_HOST ?? '127.0.0.1';

/** Roots scanned for git repos when creating a session. */
export const REPO_ROOTS = (process.env.CC_REPO_ROOTS ?? '~/Dev')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

export const NTFY_URL = process.env.CC_NTFY_URL ?? 'http://127.0.0.1:8080';
export const NTFY_TOPIC = process.env.CC_NTFY_TOPIC ?? 'claude-sessions';

function ensureDir(): void {
  if (!existsSync(CC_DIR)) mkdirSync(CC_DIR, { recursive: true, mode: 0o700 });
}

/**
 * Bearer token, generated on first run. This is defence in depth behind the
 * Tailscale-only bind — the token grants what amounts to shell access.
 */
export function getToken(): string {
  if (process.env.CC_TOKEN) return process.env.CC_TOKEN;
  ensureDir();
  if (existsSync(TOKEN_PATH)) return readFileSync(TOKEN_PATH, 'utf8').trim();
  const token = randomBytes(24).toString('hex');
  writeFileSync(TOKEN_PATH, `${token}\n`, { mode: 0o600 });
  chmodSync(TOKEN_PATH, 0o600);
  return token;
}

const DEFAULT_SERVERS: ServerConfig[] = [
  { id: 'sam', label: 'sam (local)', kind: 'local' },
];

export function loadServers(): ServerConfig[] {
  ensureDir();
  if (!existsSync(SERVERS_PATH)) {
    writeFileSync(SERVERS_PATH, `${JSON.stringify(DEFAULT_SERVERS, null, 2)}\n`, { mode: 0o600 });
    return DEFAULT_SERVERS;
  }
  try {
    const parsed = JSON.parse(readFileSync(SERVERS_PATH, 'utf8')) as ServerConfig[];
    if (!Array.isArray(parsed) || parsed.length === 0) return DEFAULT_SERVERS;
    return parsed;
  } catch (err) {
    console.error(`[config] ${SERVERS_PATH} is not valid JSON, using defaults:`, err);
    return DEFAULT_SERVERS;
  }
}
