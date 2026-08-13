import {
  createHash,
  randomBytes,
  scrypt as scryptCb,
  timingSafeEqual,
  type ScryptOptions,
} from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { CC_DIR } from './config.js';

/*
 * promisify resolves to scrypt's 3-argument overload, which drops the options
 * parameter the cost settings are passed through, so the signature is restated.
 */
const scrypt = promisify(scryptCb) as (
  password: string,
  salt: string,
  keylen: number,
  options: ScryptOptions,
) => Promise<Buffer>;

const USERS_PATH = join(CC_DIR, 'users.json');
const SESSIONS_PATH = join(CC_DIR, 'sessions.json');

/** scrypt cost. 128 * N * r ≈ 16 MB of memory per verification. */
const SCRYPT = { N: 16_384, r: 8, p: 1, keylen: 64 } as const;

/** Sessions are long-lived: this is a personal tool, not a bank. */
const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/** Failed logins per username before a lockout, and how long it lasts. */
const MAX_FAILS = 5;
const LOCKOUT_MS = 30_000;

interface UserRecord {
  salt: string;
  hash: string;
  algo: 'scrypt';
  updatedAt: number;
}

interface SessionRecord {
  /** SHA-256 of the token, never the token itself: a leaked file is not a key. */
  tokenHash: string;
  username: string;
  createdAt: number;
  lastSeen: number;
  label: string;
}

function ensureDir(): void {
  if (!existsSync(CC_DIR)) mkdirSync(CC_DIR, { recursive: true, mode: 0o700 });
}

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch (err) {
    console.error(`[auth] ${path} is unreadable, ignoring it:`, err);
    return fallback;
  }
}

/** Atomic write so a crash cannot truncate the credentials file. */
function writeJson(path: string, value: unknown): void {
  ensureDir();
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

const sha256 = (input: string): string =>
  createHash('sha256').update(input).digest('hex');

/** Compare without leaking length or position through timing. */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // timingSafeEqual throws on length mismatch, so compare against self to keep
    // the work constant, then fail.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

export async function hashPassword(password: string): Promise<UserRecord> {
  const salt = randomBytes(16).toString('hex');
  const derived = await scrypt(password, salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
  });
  return {
    salt,
    hash: derived.toString('hex'),
    algo: 'scrypt',
    updatedAt: Date.now(),
  };
}

export function setUser(username: string, record: UserRecord): void {
  const users = readJson<Record<string, UserRecord>>(USERS_PATH, {});
  users[username] = record;
  writeJson(USERS_PATH, users);
}

export function listUsers(): string[] {
  return Object.keys(readJson<Record<string, UserRecord>>(USERS_PATH, {}));
}

export function hasUsers(): boolean {
  return listUsers().length > 0;
}

const fails = new Map<string, { count: number; until: number }>();

export function lockoutRemainingMs(username: string): number {
  const entry = fails.get(username);
  if (!entry) return 0;
  return Math.max(0, entry.until - Date.now());
}

function recordFailure(username: string): void {
  const entry = fails.get(username) ?? { count: 0, until: 0 };
  entry.count += 1;
  if (entry.count >= MAX_FAILS) {
    // Escalate: every further burst of failures costs longer.
    entry.until = Date.now() + LOCKOUT_MS * Math.ceil(entry.count / MAX_FAILS);
  }
  fails.set(username, entry);
}

export interface LoginResult {
  token: string;
  username: string;
  expiresAt: number;
}

/**
 * Verify a password and mint a session token.
 *
 * Returns null for any failure — unknown user and wrong password are deliberately
 * indistinguishable, and an unknown user still pays the scrypt cost so the response
 * time does not reveal whether the account exists.
 */
export async function login(
  username: string,
  password: string,
  label: string,
): Promise<LoginResult | null> {
  const users = readJson<Record<string, UserRecord>>(USERS_PATH, {});
  const record = users[username];

  const salt = record?.salt ?? randomBytes(16).toString('hex');
  const derived = await scrypt(password, salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
  });

  if (!record || !safeEqual(derived.toString('hex'), record.hash)) {
    recordFailure(username);
    return null;
  }

  fails.delete(username);

  const token = randomBytes(32).toString('hex');
  const sessions = readJson<SessionRecord[]>(SESSIONS_PATH, []);
  const now = Date.now();
  sessions.push({
    tokenHash: sha256(token),
    username,
    createdAt: now,
    lastSeen: now,
    label: label.slice(0, 80),
  });
  writeJson(SESSIONS_PATH, prune(sessions));

  return { token, username, expiresAt: now + SESSION_TTL_MS };
}

function prune(sessions: SessionRecord[]): SessionRecord[] {
  const cutoff = Date.now() - SESSION_TTL_MS;
  return sessions.filter((s) => s.lastSeen > cutoff);
}

/** Resolve a session token to its username, or null. Refreshes lastSeen lazily. */
export function verifySession(token: string): string | null {
  if (!token) return null;
  const wanted = sha256(token);
  const sessions = readJson<SessionRecord[]>(SESSIONS_PATH, []);
  const match = sessions.find((s) => safeEqual(s.tokenHash, wanted));
  if (!match) return null;
  if (Date.now() - match.lastSeen > SESSION_TTL_MS) return null;

  // Only rewrite the file when the timestamp is meaningfully stale, so ordinary
  // request traffic is not doing a disk write per call.
  if (Date.now() - match.lastSeen > 60 * 60 * 1000) {
    match.lastSeen = Date.now();
    writeJson(SESSIONS_PATH, prune(sessions));
  }
  return match.username;
}

export function revokeSession(token: string): boolean {
  const wanted = sha256(token);
  const sessions = readJson<SessionRecord[]>(SESSIONS_PATH, []);
  const remaining = sessions.filter((s) => !safeEqual(s.tokenHash, wanted));
  if (remaining.length === sessions.length) return false;
  writeJson(SESSIONS_PATH, remaining);
  return true;
}

/** Sign every device out — the recovery path if a phone is lost. */
export function revokeAll(): number {
  const sessions = readJson<SessionRecord[]>(SESSIONS_PATH, []);
  writeJson(SESSIONS_PATH, []);
  return sessions.length;
}

export function activeSessions(): Array<Omit<SessionRecord, 'tokenHash'>> {
  return prune(readJson<SessionRecord[]>(SESSIONS_PATH, [])).map(
    ({ tokenHash: _tokenHash, ...rest }) => rest,
  );
}

export { safeEqual };
