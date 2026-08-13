/**
 * Exercise the markdown renderer without a browser, via a minimal DOM stub.
 *
 *   node scripts/test-markdown.mjs            # fixture cases
 *   node scripts/test-markdown.mjs <file.jsonl>  # real assistant messages
 */
import { readFileSync } from 'node:fs';
import { renderMarkdown } from '../web/markdown.js';

/* ---------- minimal DOM ---------- */

const VOID = new Set(['hr', 'br']);

class Node {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.attrs = {};
    this._class = '';
  }
  set className(v) { this._class = v; }
  get className() { return this._class; }
  setAttribute(k, v) { this.attrs[k] = v; }
  appendChild(child) { this.children.push(child); return child; }
  get textContent() {
    return this.children.map((c) => (c.text !== undefined ? c.text : c.textContent)).join('');
  }
}

const doc = {
  createElement: (tag) => new Node(tag),
  createTextNode: (text) => ({ text }),
  createDocumentFragment: () => new Node('#frag'),
};

function serialise(node, indent = 0) {
  const pad = '  '.repeat(indent);
  if (node.text !== undefined) {
    return node.text.trim() ? `${pad}"${node.text}"` : null;
  }
  const attrs = Object.entries(node.attrs).map(([k, v]) => ` ${k}=${JSON.stringify(v)}`).join('');
  const cls = node._class ? ` .${node._class}` : '';
  const head = `${pad}<${node.tag}${cls}${attrs}>`;
  if (VOID.has(node.tag)) return head;
  const kids = node.children.map((c) => serialise(c, indent + 1)).filter(Boolean);
  return kids.length ? `${head}\n${kids.join('\n')}` : head;
}

const render = (md) => serialise(renderMarkdown(md, doc));

/* ---------- assertions ---------- */

let failures = 0;
function check(name, md, ...expectations) {
  const out = render(md) ?? '';
  const missing = expectations.filter((e) => !out.includes(e));
  if (missing.length) {
    failures += 1;
    console.log(`FAIL ${name}`);
    console.log(`  missing: ${missing.map((m) => JSON.stringify(m)).join(', ')}`);
    console.log(out.replace(/^/gm, '    '));
  } else {
    console.log(`ok   ${name}`);
  }
}

check('bold', 'this is **very** important', '<strong>', '"very"');
check('italic asterisk', 'this is *slanted* text', '<em>', '"slanted"');
check('italic underscore', 'this is _slanted_ text', '<em>');
check('snake_case is not italic', 'call some_var_name here', '"call some_var_name here"');
check('bold inside italic', '*outer **inner** rest*', '<em>', '<strong>');
check('inline code', 'run `npm test` now', '<code data-copy="inline">', '"npm test"');
check('code suppresses markup', 'literal `**not bold**` here',
      '<code data-copy="inline">', '"**not bold**"');
check('strikethrough', 'this is ~~gone~~', '<del>');
check('link', 'see [the docs](https://example.com/x) here',
      '<a href="https://example.com/x"', 'rel="noopener noreferrer"');
check('javascript: url is inert', '[click](javascript:alert(1))', '"click"');
check('bare url', 'go to https://example.com now', '<a href="https://example.com"');
check('heading', '## Section title', '<h4>', '"Section title"');
check('fenced code', '```js\nconst a = 1;\n```',
      '<pre>', '<code .lang-js>', '"const a = 1;"',
      // The block is wrapped so a copy button can be positioned over it.
      '<div .code-wrap>', '<button .copy-btn', 'data-copy="block"')
check('fence keeps markup literal', '```\n**stars**\n```', '"**stars**"');
check('bullet list', '- one\n- two\n- three', '<ul>', '<li>', '"one"', '"three"');
check('ordered list', '1. first\n2. second', '<ol>', '"first"');
check('nested list', '- outer\n  - inner\n- back', '<li>\n      <span>\n        "outer"\n      <ul>', '"inner"');
check('em inside strong', '**outer *inner* rest**', '<strong>', '<em>', '"inner"');
check('em wrapping strong', '*outer **inner** rest*',
      '<em>\n      "outer "\n      <strong>', '"inner"');
check('blockquote', '> quoted line', '<blockquote>', '"quoted line"');
check('rule', 'above\n\n---\n\nbelow', '<hr>');
check('table', '| a | b |\n|---|---|\n| 1 | 2 |',
      '<div .md-scroll>', '<table>', '<th>', '<td>', '"1"');
check('escaped star', 'literal \\*not italic\\*', '"literal *not italic*"');
check('paragraphs split on blank line', 'one\n\ntwo', '<p>');
check('unclosed bold degrades to text', 'this ** never closes', '"this ** never closes"');

/* ---------- real transcript sample ---------- */

const file = process.argv[2];
if (file) {
  const texts = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    if (d.type !== 'assistant' || d.isSidechain) continue;
    for (const b of d.message?.content ?? []) {
      if (b?.type === 'text' && b.text?.trim()) texts.push(b.text);
    }
  }
  console.log(`\n--- ${texts.length} real assistant messages from ${file.split('/').pop()} ---`);
  let crashed = 0;
  for (const t of texts) {
    try { renderMarkdown(t, doc); } catch (err) { crashed += 1; console.log('  CRASH:', err.message); }
  }
  console.log(`  rendered without error: ${texts.length - crashed}/${texts.length}`);
  const sample = texts.find((t) => t.includes('**') && t.includes('\n'));
  if (sample) {
    console.log('\n--- sample render ---');
    console.log(`  input: ${JSON.stringify(sample.slice(0, 160))}`);
    console.log(render(sample).split('\n').slice(0, 22).join('\n'));
  }
  if (crashed) failures += crashed;
}

console.log(failures ? `\n${failures} FAILURES` : '\nall markdown checks passed');
process.exitCode = failures ? 1 : 0;
