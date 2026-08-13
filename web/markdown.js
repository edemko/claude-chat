/**
 * Small markdown renderer for chat messages.
 *
 * Builds DOM nodes directly and never touches innerHTML — message text comes from a
 * model and from tool output, so it is treated as untrusted throughout.
 *
 * Supports what Claude actually emits: fenced and inline code, headings, ordered and
 * unordered lists (nested), blockquotes, tables, rules, links, bold, italic, strike.
 *
 * `doc` is injectable so the parser can be exercised without a browser.
 */

const MAX_DEPTH = 6;
const SAFE_SCHEME = /^(https?:|mailto:)/i;

const isWord = (ch) => !!ch && /\w/.test(ch);

/*
 * Order matters: code spans come first so nothing inside them is reinterpreted, and
 * the two-character markers (**, __, ~~) must be tried before their single-character
 * counterparts.
 */
const INLINE_RULES = [
  { kind: 'code', re: /^(`+)([\s\S]*?)\1/ },
  { kind: 'strong', re: /^\*\*([\s\S]+?)\*\*/ },
  { kind: 'strong', re: /^__([\s\S]+?)__/, wordGuard: true },
  { kind: 'del', re: /^~~([\s\S]+?)~~/ },
  /*
   * Emphasis has to step over `**` pairs to find its own closing marker, or
   * `*outer **inner** rest*` closes the italic at the first inner star and produces
   * three sibling <em>s instead of an <em> wrapping a <strong>.
   */
  { kind: 'em', re: /^\*((?:[^*\n]|\*\*)+?)\*(?!\*)/ },
  { kind: 'em', re: /^_((?:[^_\n]|__)+?)_(?!_)/, wordGuard: true },
  { kind: 'link', re: /^\[([^\]\n]*)\]\(\s*([^)\s]+)[^)]*\)/ },
  { kind: 'autolink', re: /^(https?:\/\/[^\s<>()[\]]+)/ },
];

function renderInline(text, parent, doc, depth = 0) {
  if (depth > MAX_DEPTH) {
    parent.appendChild(doc.createTextNode(text));
    return;
  }

  let buffer = '';
  let i = 0;
  const flush = () => {
    if (buffer) {
      parent.appendChild(doc.createTextNode(buffer));
      buffer = '';
    }
  };

  while (i < text.length) {
    // Backslash escapes: take the next character literally.
    if (text[i] === '\\' && i + 1 < text.length && /[\\`*_~[\]()#>-]/.test(text[i + 1])) {
      buffer += text[i + 1];
      i += 2;
      continue;
    }

    const rest = text.slice(i);
    let hit = null;
    for (const rule of INLINE_RULES) {
      const m = rule.re.exec(rest);
      if (!m) continue;
      if (rule.wordGuard) {
        // Stops snake_case identifiers from turning into emphasis.
        const after = rest[m[0].length];
        if (isWord(text[i - 1]) || isWord(after)) continue;
      }
      hit = { rule, m };
      break;
    }

    if (!hit) {
      buffer += text[i];
      i += 1;
      continue;
    }

    flush();
    parent.appendChild(buildInline(hit.rule.kind, hit.m, doc, depth));
    i += hit.m[0].length;
  }
  flush();
}

function buildInline(kind, m, doc, depth) {
  if (kind === 'code') {
    const code = doc.createElement('code');
    code.appendChild(doc.createTextNode(m[2].trim()));
    return code;
  }

  if (kind === 'link' || kind === 'autolink') {
    const href = kind === 'autolink' ? m[1] : m[2];
    const label = kind === 'autolink' ? m[1] : m[1] || href;
    if (!SAFE_SCHEME.test(href)) {
      // Unknown scheme (javascript:, data:, …): render the label as plain text.
      return doc.createTextNode(label);
    }
    const a = doc.createElement('a');
    a.setAttribute('href', href);
    a.setAttribute('target', '_blank');
    a.setAttribute('rel', 'noopener noreferrer');
    renderInline(label, a, doc, depth + 1);
    return a;
  }

  const tag = kind === 'strong' ? 'strong' : kind === 'em' ? 'em' : 'del';
  const el = doc.createElement(tag);
  renderInline(m[1], el, doc, depth + 1);
  return el;
}

const FENCE = /^\s*(```+|~~~+)\s*([\w+#.-]*)\s*$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const RULE = /^\s*([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^\s*>\s?(.*)$/;
const TABLE_SEP = /^\s*\|?(?:\s*:?-{2,}:?\s*\|)+\s*:?-{2,}:?\s*\|?\s*$/;

function itemMatch(line) {
  const m = /^(\s*)(?:([-*+])|(\d{1,9})[.)])\s+(.*)$/.exec(line ?? '');
  if (!m) return null;
  return {
    indent: m[1].length,
    ordered: m[3] !== undefined,
    start: m[3] ? Number(m[3]) : null,
    text: m[4],
  };
}

function listBlock(lines, start, doc, depth) {
  const first = itemMatch(lines[start]);
  const list = doc.createElement(first.ordered ? 'ol' : 'ul');
  if (first.ordered && first.start !== null && first.start !== 1) {
    list.setAttribute('start', String(first.start));
  }

  let i = start;
  while (i < lines.length) {
    const item = itemMatch(lines[i]);
    if (!item || item.indent !== first.indent || item.ordered !== first.ordered) break;

    const parts = [item.text];
    const nested = [];
    i += 1;

    // Absorb wrapped continuation lines and deeper nested lists into this item.
    while (i < lines.length) {
      const next = itemMatch(lines[i]);
      if (next && next.indent > first.indent) {
        const sub = listBlock(lines, i, doc, depth + 1);
        nested.push(sub.node);
        i = sub.next;
        continue;
      }
      if (!next && lines[i].trim() && /^\s{2,}/.test(lines[i])) {
        parts.push(lines[i].trim());
        i += 1;
        continue;
      }
      break;
    }

    const li = doc.createElement('li');
    const body = doc.createElement('span');
    renderInline(parts.join(' '), body, doc, depth);
    li.appendChild(body);
    for (const node of nested) li.appendChild(node);
    list.appendChild(li);
  }

  return { node: list, next: i };
}

function tableBlock(lines, start, doc, depth) {
  const cells = (line) =>
    line
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((c) => c.trim());

  const table = doc.createElement('table');
  const thead = doc.createElement('thead');
  const headRow = doc.createElement('tr');
  for (const heading of cells(lines[start])) {
    const th = doc.createElement('th');
    renderInline(heading, th, doc, depth);
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = doc.createElement('tbody');
  let i = start + 2; // skip the header and the |---| separator
  while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
    const tr = doc.createElement('tr');
    for (const cell of cells(lines[i])) {
      const td = doc.createElement('td');
      renderInline(cell, td, doc, depth);
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
    i += 1;
  }
  table.appendChild(tbody);

  // Wrapped so a wide table scrolls itself instead of the whole page.
  const wrap = doc.createElement('div');
  wrap.className = 'md-scroll';
  wrap.appendChild(table);
  return { node: wrap, next: i };
}

function renderBlocks(lines, doc, depth) {
  const frag = doc.createDocumentFragment();
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      i += 1;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1].startsWith('`') ? '```' : '~~~';
      const body = [];
      i += 1;
      while (i < lines.length && !lines[i].trimStart().startsWith(marker)) {
        body.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1; // closing fence
      const pre = doc.createElement('pre');
      const code = doc.createElement('code');
      if (fence[2]) code.className = `lang-${fence[2]}`;
      code.appendChild(doc.createTextNode(body.join('\n')));
      pre.appendChild(code);
      frag.appendChild(pre);
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      // Mapped to h4–h6: these are bubbles in a log, not document sections.
      const level = Math.min(6, 3 + Math.ceil(heading[1].length / 2));
      const h = doc.createElement(`h${level}`);
      renderInline(heading[2], h, doc, depth);
      frag.appendChild(h);
      i += 1;
      continue;
    }

    if (RULE.test(line)) {
      frag.appendChild(doc.createElement('hr'));
      i += 1;
      continue;
    }

    if (line.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
      const t = tableBlock(lines, i, doc, depth);
      frag.appendChild(t.node);
      i = t.next;
      continue;
    }

    if (QUOTE.test(line)) {
      const inner = [];
      while (i < lines.length && QUOTE.test(lines[i])) {
        inner.push(QUOTE.exec(lines[i])[1]);
        i += 1;
      }
      const quote = doc.createElement('blockquote');
      quote.appendChild(renderBlocks(inner, doc, depth + 1));
      frag.appendChild(quote);
      continue;
    }

    if (itemMatch(line)) {
      const list = listBlock(lines, i, doc, depth);
      frag.appendChild(list.node);
      i = list.next;
      continue;
    }

    // Paragraph: run to the next blank line or block opener.
    const para = [];
    while (i < lines.length && lines[i].trim()) {
      const l = lines[i];
      if (FENCE.test(l) || HEADING.test(l) || RULE.test(l) || QUOTE.test(l) || itemMatch(l)) break;
      para.push(l);
      i += 1;
    }
    if (para.length > 0) {
      const p = doc.createElement('p');
      renderInline(para.join('\n'), p, doc, depth);
      frag.appendChild(p);
    }
  }

  return frag;
}

export function renderMarkdown(text, doc = globalThis.document) {
  const lines = String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n');
  return renderBlocks(lines, doc, 0);
}
