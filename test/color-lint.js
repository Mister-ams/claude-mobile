#!/usr/bin/env node
// Colour lint (T04 of .planning/ipad-apple-redesign.md).
//
// Every colour in the app chrome is a token. The ONLY place a colour literal
// may appear is the first `:root { ... }` block of public/style.css (the token
// block). Everything else in style.css, and setup.html's inline <style>, must
// reference var(--token). This fails (exit 1) on any hex, rgb(a), hsl(a) or
// named-colour literal outside that block, printing file:line for each.
//
// Usage: node test/color-lint.js [style.css] [setup.html]
// No dependencies.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const cssPath = process.argv[2] || path.join(root, 'public', 'style.css');
const setupPath = process.argv[3] || path.join(root, 'public', 'setup.html');

// Hex (#rgb, #rgba, #rrggbb, #rrggbbaa), functional notations, and the named
// colours people actually reach for. `transparent`, `currentColor`, `inherit`
// and `none` are keywords, not palette choices, and stay allowed.
const LITERAL = new RegExp(
  '#[0-9a-fA-F]{3,8}\\b' +
  '|\\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\\s*\\(' +
  '|:\\s*(?:white|black|red|green|blue|yellow|orange|gray|grey|gold|silver)\\s*[;}!]'
);

function stripComments(text) {
  // Keep newlines so line numbers stay true.
  return text.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '));
}

// Blank out the first `:root { ... }` block (brace-balanced), keeping lines.
function blankTokenBlock(text) {
  const start = text.search(/(^|\n)\s*:root\s*\{/);
  if (start < 0) return { text, found: false };
  const open = text.indexOf('{', start);
  let depth = 0, end = -1;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) { end = i; break; }
  }
  if (end < 0) return { text, found: false };
  const blanked = text.slice(start, end + 1).replace(/[^\n]/g, ' ');
  return { text: text.slice(0, start) + blanked + text.slice(end + 1), found: true };
}

function scan(label, text, lineOffset) {
  const hits = [];
  text.split('\n').forEach((line, i) => {
    const m = LITERAL.exec(line);
    if (m) hits.push(`${label}:${i + 1 + lineOffset}: ${m[0].trim()}  | ${line.trim()}`);
  });
  return hits;
}

const failures = [];

const css = stripComments(fs.readFileSync(cssPath, 'utf8'));
const tb = blankTokenBlock(css);
if (!tb.found) failures.push(`${path.relative(root, cssPath)}: no :root token block found`);
failures.push(...scan(path.relative(root, cssPath), tb.text, 0));

// setup.html: only its <style> blocks are CSS; <meta name="theme-color"> is
// an HTML attribute the browser needs as a literal, so markup is not scanned.
const html = fs.readFileSync(setupPath, 'utf8');
const styleRe = /<style[^>]*>([\s\S]*?)<\/style>/gi;
let sm;
while ((sm = styleRe.exec(html))) {
  const offset = html.slice(0, sm.index + sm[0].indexOf('>') + 1).split('\n').length - 1;
  failures.push(...scan(path.relative(root, setupPath), stripComments(sm[1]), offset));
}

if (failures.length) {
  console.error(`colour lint FAILED: ${failures.length} literal(s) outside the token block`);
  for (const f of failures) console.error('  ' + f);
  process.exit(1);
}
console.log('colour lint OK: no colour literals outside the :root token block');
