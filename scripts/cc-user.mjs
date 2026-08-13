#!/usr/bin/env node
/**
 * Manage login credentials for the hub.
 *
 *   node scripts/cc-user.mjs set <username>     # prompts twice, input hidden
 *   node scripts/cc-user.mjs list               # users and active devices
 *   node scripts/cc-user.mjs logout-all         # sign every device out
 *
 * The password is read from the terminal with echo off, or from CC_PASSWORD for
 * non-interactive use. It is never written to disk or logged — only its scrypt hash
 * goes into ~/.claude-chat/users.json.
 *
 * Requires a build first: npm run build
 */
import { createInterface } from 'node:readline';
import { stdin, stdout, argv, env, exit } from 'node:process';

import {
  activeSessions,
  hashPassword,
  listUsers,
  revokeAll,
  setUser,
} from '../dist/auth.js';

/** Prompt with the terminal's echo suppressed. */
function askHidden(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: stdin, output: stdout, terminal: true });
    // Suppress echo by swallowing everything readline tries to render after the
    // prompt itself has been written.
    let promptWritten = false;
    rl._writeToOutput = (chunk) => {
      if (!promptWritten) {
        rl.output.write(question);
        promptWritten = true;
      } else if (chunk.includes('\n')) {
        rl.output.write('\n');
      }
    };
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

function ask(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: stdin, output: stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function cmdSet(username) {
  if (!username) {
    console.error('usage: node scripts/cc-user.mjs set <username>');
    exit(1);
  }
  if (!/^[a-zA-Z0-9._-]{1,32}$/.test(username)) {
    console.error('username must be 1-32 chars of letters, digits, dot, dash or underscore');
    exit(1);
  }

  let password = env.CC_PASSWORD;
  if (password) {
    console.log('using CC_PASSWORD from the environment');
  } else {
    password = await askHidden(`password for "${username}": `);
    const again = await askHidden('repeat: ');
    if (password !== again) {
      console.error('\npasswords do not match — nothing was changed');
      exit(1);
    }
  }

  // A hard floor only against typos and empties. Anything weak is reported rather
  // than blocked: the hub is reachable from the tailnet only, so the owner gets to
  // decide, but should not be able to forget the choice.
  if (password.length < 4) {
    console.error('\npassword must be at least 4 characters — nothing was changed');
    exit(1);
  }

  const warnings = [];
  if (password.length < 8) warnings.push(`only ${password.length} characters`);
  if (password.toLowerCase() === username.toLowerCase()) {
    warnings.push('identical to the username');
  }
  if (/^[a-z]+$/.test(password)) warnings.push('lowercase letters only');

  setUser(username, await hashPassword(password));
  console.log(`\nsaved. "${username}" can now log in from the app.`);
  if (warnings.length) {
    console.log(`\n!  This password is weak: ${warnings.join(', ')}.`);
    console.log('!  Acceptable only because the hub is bound to Tailscale and is not');
    console.log('!  reachable from the internet. Anyone on your tailnet could guess it.');
    console.log('!  Change it any time with the same command.');
  }
  console.log('Existing devices keep working; the bearer token in ~/.claude-chat/token');
  console.log('also still works, for scripts and the APK download link.');
}

function cmdList() {
  const users = listUsers();
  console.log(users.length ? `users: ${users.join(', ')}` : 'no users yet — run: set <username>');

  const sessions = activeSessions();
  if (!sessions.length) {
    console.log('no logged-in devices');
    return;
  }
  console.log(`\n${sessions.length} logged-in device(s):`);
  for (const s of sessions) {
    const seen = new Date(s.lastSeen).toISOString().replace('T', ' ').slice(0, 16);
    console.log(`  ${s.username.padEnd(12)} last seen ${seen}  ${s.label}`);
  }
}

async function cmdLogoutAll() {
  const answer = await ask('Sign out every device? [y/N] ');
  if (answer.toLowerCase() !== 'y') {
    console.log('nothing changed');
    return;
  }
  console.log(`revoked ${revokeAll()} session(s) — every device must log in again`);
}

const [, , command, arg] = argv;
switch (command) {
  case 'set':
    await cmdSet(arg);
    break;
  case 'list':
    cmdList();
    break;
  case 'logout-all':
    await cmdLogoutAll();
    break;
  default:
    console.log('usage: node scripts/cc-user.mjs set <username> | list | logout-all');
    exit(command ? 1 : 0);
}
