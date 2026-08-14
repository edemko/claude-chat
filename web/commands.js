/**
 * Slash-command matching, and the copy for the help sheet.
 *
 * Pure functions and data — no DOM, no fetch — so the ranking can be tested with
 * `node scripts/test-commands.mjs` and the composer keeps only the wiring.
 */

/**
 * The command being typed, when the caret is still inside its name.
 *
 * Claude Code only treats a slash as a command when it opens the message, so this
 * deliberately refuses to fire on a slash anywhere else: a path in the middle of a
 * sentence must not pop a menu up over the thread.
 *
 * Returns `null` when no completion should be offered.
 */
export function parseSlash(text, caret) {
  if (!text.startsWith('/')) return null;
  const space = text.search(/\s/);
  const end = space < 0 ? text.length : space;
  // Past the name means the arguments are being typed; the name is settled.
  if (caret > end) return null;
  return { query: text.slice(1, end), from: 0, to: end };
}

/** The command name a message opens with, arguments or not. Null when it is prose. */
export function leadingCommand(text) {
  if (!text.startsWith('/')) return null;
  const name = text.slice(1).split(/\s/)[0] ?? '';
  return name.length > 0 ? name : null;
}

/** Custom commands come first: there are few, they are yours, and you named them. */
const SOURCE_RANK = { project: 0, user: 1, skill: 2, builtin: 3 };

export const SOURCE_LABEL = {
  builtin: 'built in',
  user: 'yours',
  project: 'this project',
  skill: 'skill',
};

/** Every character of `query` appears in `name`, in order — `cmp` finds `compact`. */
function subsequence(name, query) {
  let at = 0;
  for (const ch of query) {
    at = name.indexOf(ch, at) + 1;
    if (at === 0) return false;
  }
  return true;
}

/**
 * Commands matching what has been typed, best first.
 *
 * Four tiers, because they mean different things: an exact name is what you meant, a
 * prefix is what you are typing, an interior match is what you half-remember, and a
 * description match is what you are looking for without knowing its name.
 */
export function rankCommands(query, commands) {
  const q = query.toLowerCase();
  if (!q) {
    return [...commands].sort(
      (a, b) => SOURCE_RANK[a.source] - SOURCE_RANK[b.source] || a.name.localeCompare(b.name),
    );
  }

  const scored = [];
  for (const cmd of commands) {
    const name = cmd.name.toLowerCase();
    let tier;
    if (name === q) tier = 0;
    else if (name.startsWith(q)) tier = 1;
    else if (name.includes(q)) tier = 2;
    else if (subsequence(name, q)) tier = 3;
    // Searching the description only once there is enough of a word to mean
    // something; two letters match half the list and drown the name matches.
    else if (q.length >= 3 && cmd.description.toLowerCase().includes(q)) tier = 4;
    else continue;
    scored.push({ cmd, tier });
  }

  scored.sort(
    (a, b) =>
      a.tier - b.tier ||
      SOURCE_RANK[a.cmd.source] - SOURCE_RANK[b.cmd.source] ||
      a.cmd.name.length - b.cmd.name.length ||
      a.cmd.name.localeCompare(b.cmd.name),
  );
  return scored.map((s) => s.cmd);
}

/** Matches a command's name or its description, for the help sheet's filter box. */
export function filterCommands(query, commands) {
  const q = query.trim().toLowerCase();
  if (!q) return commands;
  return commands.filter(
    (c) => c.name.toLowerCase().includes(q) || c.description.toLowerCase().includes(q),
  );
}

/**
 * Help copy.
 *
 * Written for someone holding a phone who has not read the README: what the thing in
 * front of them does, and the two or three behaviours that are surprising if nobody
 * says them out loud.
 */
export const HELP_SECTIONS = [
  {
    title: 'What this is',
    items: [
      [
        'A window onto real sessions',
        'Every conversation here is a Claude Code session running in tmux on your ' +
          'server. Nothing lives in this app — close it, and the session carries on.',
      ],
      [
        'Your desk and your phone, same session',
        'What you send here appears in the terminal, and what you type in the terminal ' +
          'appears here. Two people typing into one prompt is the one thing to avoid.',
      ],
    ],
  },
  {
    title: 'Slash commands',
    items: [
      [
        'Start a message with /',
        'A menu of matching commands opens as you type. ↑ and ↓ move, Tab or Enter ' +
          'completes, Esc closes it. Tap one to fill it in.',
      ],
      [
        'Search by meaning',
        'The menu matches descriptions too, so typing /summar finds /compact.',
      ],
      [
        'Your own commands are listed',
        'Files in ~/.claude/commands and .claude/commands in the project, plus your ' +
          'skills, appear alongside the built-in ones and are marked as yours.',
      ],
      [
        'Unknown commands are flagged',
        'A command the session will not recognise is underlined in the box before you ' +
          'send it — a typo costs a wasted turn otherwise.',
      ],
    ],
  },
  {
    title: 'The key bar',
    items: [
      ['esc', 'Interrupt what Claude is doing, or dismiss a menu it is showing.'],
      ['^C', 'Ctrl-C. Clears the prompt; twice in a row exits the session.'],
      ['↑ ↓', 'Move through a menu, or recall an earlier prompt.'],
      ['⇥ / ⇧⇥', 'Tab and Shift-Tab. Shift-Tab cycles the permission mode.'],
      ['⏎', 'A bare Enter — for confirming a prompt without sending a message.'],
      ['screen', "Show the pane exactly as the terminal has it, when the thread does not look right."],
      ['conversation', 'Pick which transcript this pane is showing, if it guessed wrong.'],
    ],
  },
  {
    title: 'Sessions',
    items: [
      [
        'Grouped by project',
        'Repos are highlighted; plain folders are dimmed. A session is identified by ' +
          'its project first, because conversation names repeat across them.',
      ],
      [
        'ⓘ shows the real numbers',
        'Model, context used, token counts, branch, uptime — scraped from the ' +
          "session's own status line, so it matches what the terminal shows.",
      ],
      [
        'A guessed match says so',
        'This app works out which transcript a pane is running. When it cannot be ' +
          'sure it tells you, and "conversation" lets you correct it.',
      ],
    ],
  },
  {
    title: 'Sending more than text',
    items: [
      [
        'Screenshots',
        'The 🖼 button uploads an image to the server and hands the session its path, ' +
          'which is how Claude Code is given a picture. Anything typed becomes the caption.',
      ],
      [
        'Copying out',
        'Code blocks have a copy button; tap inline code to copy it. Text is selectable ' +
          'the normal way.',
      ],
    ],
  },
  {
    title: 'Starting a session',
    items: [
      [
        '＋ lists your repos',
        'Found under the roots the hub is configured with. Browse from there to any ' +
          'folder on the machine, and create one if it does not exist yet.',
      ],
      [
        'Permissions are skipped by default',
        'New sessions start with --dangerously-skip-permissions, so they act without ' +
          'asking. Untick it in the sheet if that is not what you want.',
      ],
    ],
  },
];
