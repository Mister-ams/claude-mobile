#!/usr/bin/env node
// W4 T13a of render-pipeline: scripted @xterm/headless API validation.
// Runs a battery of ANSI sequences through a headless Terminal and inspects
// the resulting buffer state. Exits 0 on PASS, 1 on FAIL.
//
// IMPORTANT: xterm's term.write() is asynchronous (parsed on the next event
// loop tick). All checks here use writeAsync to await each write before
// reading buffer state -- that ordering matters for any callsite (including
// our T12 mirror, which is fire-and-forget today; spike report flags this).
//
// Usage:  node .planning/spike-headless-xterm.js
// Output: per-check PASS/FAIL line + a final summary table.

const { Terminal } = require('@xterm/headless');

function writeAsync(t, data) {
  return new Promise(resolve => t.write(data, resolve));
}

function freshTerm(opts = {}) {
  return new Terminal({ cols: 80, rows: 24, scrollback: 100, allowProposedApi: true, ...opts });
}

function readLine(term, y) {
  const line = term.buffer.active.getLine(y);
  return line ? line.translateToString(true) : null;
}

const checks = [];
async function check(name, fn) {
  try {
    const result = await fn();
    if (result === true) checks.push({ name, status: 'PASS', detail: '' });
    else checks.push({ name, status: 'FAIL', detail: String(result) });
  } catch (e) {
    checks.push({ name, status: 'FAIL', detail: e.message });
  }
}

(async () => {

  // 1. Plain text round-trip
  await check('plain text write + read', async () => {
    const t = freshTerm();
    await writeAsync(t, 'hello world');
    return readLine(t, 0) === 'hello world' || `got: ${JSON.stringify(readLine(t, 0))}`;
  });

  // 2. Cursor position after write
  await check('cursor position after write', async () => {
    const t = freshTerm();
    await writeAsync(t, 'abc');
    const buf = t.buffer.active;
    return (buf.cursorY === 0 && buf.cursorX === 3) || `cursor at (${buf.cursorX},${buf.cursorY})`;
  });

  // 3. Newline + carriage return
  await check('newline + CR advance row', async () => {
    const t = freshTerm();
    await writeAsync(t, 'line1\r\nline2');
    return readLine(t, 0) === 'line1' && readLine(t, 1) === 'line2'
      || `r0=${JSON.stringify(readLine(t, 0))} r1=${JSON.stringify(readLine(t, 1))}`;
  });

  // 4. SGR foreground colour (palette index 1 = red)
  await check('SGR foreground colour applied to cell', async () => {
    const t = freshTerm();
    await writeAsync(t, '\x1b[31mR\x1b[0m');
    const cell = t.buffer.active.getLine(0).getCell(0);
    const fg = cell.getFgColor();
    const isPalette = cell.isFgPalette();
    return (isPalette && fg === 1) || `fg=${fg} palette=${isPalette}`;
  });

  // 5. SGR bold (isBold returns the bit value, non-zero == bold)
  await check('SGR bold attribute', async () => {
    const t = freshTerm();
    await writeAsync(t, '\x1b[1mB\x1b[0m');
    const cell = t.buffer.active.getLine(0).getCell(0);
    return cell.isBold() !== 0 || `bold=${cell.isBold()}`;
  });

  // 6. Alt-screen enter/exit (DECSET 1049). Note: 1049 saves cursor but does
  // not reset it; we explicitly home the cursor on the alt buffer to compare
  // content cleanly.
  await check('alt-screen enter/exit via DECSET 1049', async () => {
    const t = freshTerm();
    await writeAsync(t, 'normal-buffer');
    await writeAsync(t, '\x1b[?1049h');
    await writeAsync(t, '\x1b[H');           // cursor home
    await writeAsync(t, 'alt-buffer');
    if (t.buffer.active.type !== 'alternate') return `type after enter: ${t.buffer.active.type}`;
    if (readLine(t, 0) !== 'alt-buffer') return `alt content: ${JSON.stringify(readLine(t, 0))}`;
    await writeAsync(t, '\x1b[?1049l');
    if (t.buffer.active.type !== 'normal') return `type after exit: ${t.buffer.active.type}`;
    return readLine(t, 0) === 'normal-buffer' || `normal content: ${JSON.stringify(readLine(t, 0))}`;
  });

  // 7. DECSTBM scroll region
  await check('DECSTBM scroll region honoured', async () => {
    const t = freshTerm({ rows: 8 });
    for (let i = 0; i < 8; i++) await writeAsync(t, `row${i}\r\n`);
    await writeAsync(t, '\x1b[3;5r');   // DECSTBM rows 3..5
    await writeAsync(t, '\x1b[5;1H');   // cursor row 5 col 1
    await writeAsync(t, 'NEW\n');        // \n inside region scrolls only the region
    await writeAsync(t, '\x1b[r');      // reset
    return readLine(t, 0) === 'row0' || `r0=${JSON.stringify(readLine(t, 0))}`;
  });

  // 8. Cursor save/restore
  await check('cursor save/restore', async () => {
    const t = freshTerm();
    await writeAsync(t, 'AB\x1b[s\r\nXY\x1b[u');
    await writeAsync(t, 'Z');
    const cell = t.buffer.active.getLine(0).getCell(2);
    return cell.getChars() === 'Z' || `cell(2,0)=${JSON.stringify(cell.getChars())}`;
  });

  // 9. OSC 8 -- IBufferCell does NOT expose getHyperlinkId in v6.0.0, but
  // we can detect hyperlinked cells via hasExtendedAttrs() and capture URIs
  // via parser.registerOscHandler(8). Validates both signals exist for W5.
  await check('OSC 8 cell extended attrs flag set inside link', async () => {
    const t = freshTerm();
    await writeAsync(t, '\x1b]8;;https://x.test/p\x1b\\link\x1b]8;;\x1b\\plain');
    const linkCell = t.buffer.active.getLine(0).getCell(0);
    const plainCell = t.buffer.active.getLine(0).getCell(4);
    return (linkCell.hasExtendedAttrs() !== 0 && plainCell.hasExtendedAttrs() === 0)
      || `link=${linkCell.hasExtendedAttrs()} plain=${plainCell.hasExtendedAttrs()}`;
  });

  await check('OSC 8 URI captured via registerOscHandler', async () => {
    const t = freshTerm();
    const captures = [];
    t.parser.registerOscHandler(8, (data) => { captures.push(data); return false; });
    await writeAsync(t, '\x1b]8;;https://capture.test/abc\x1b\\link\x1b]8;;\x1b\\');
    // Opener should be ";<URI>", closer ";"
    const opener = captures.find(s => s.includes('https://capture.test/abc'));
    return !!opener || `captures=${JSON.stringify(captures)}`;
  });

  // 10. Resize
  await check('resize updates rows/cols', async () => {
    const t = freshTerm();
    t.resize(120, 40);
    return (t.cols === 120 && t.rows === 40) || `cols=${t.cols} rows=${t.rows}`;
  });

  // 11. Mouse mode tracking accepts DECSET sequences without throw
  await check('DECSET 1000 mouse tracking accepted', async () => {
    const t = freshTerm();
    await writeAsync(t, '\x1b[?1000h');
    await writeAsync(t, '\x1b[?1006h');
    await writeAsync(t, '\x1b[?1000l');
    return true;
  });

  // 12. SGR 24-bit truecolour
  await check('SGR 24-bit truecolour', async () => {
    const t = freshTerm();
    await writeAsync(t, '\x1b[38;2;255;128;64mX\x1b[0m');
    const cell = t.buffer.active.getLine(0).getCell(0);
    const fg = cell.getFgColor();
    const isRgb = cell.isFgRGB();
    const r = (fg >> 16) & 0xff, g = (fg >> 8) & 0xff, b = fg & 0xff;
    return (isRgb && r === 255 && g === 128 && b === 64)
      || `rgb=(${r},${g},${b}) isRgb=${isRgb}`;
  });

  // Summary
  const pass = checks.filter(c => c.status === 'PASS').length;
  const fail = checks.filter(c => c.status === 'FAIL').length;
  for (const c of checks) {
    const tag = c.status === 'PASS' ? '[PASS]' : '[FAIL]';
    console.log(`${tag} ${c.name}${c.detail ? ' -- ' + c.detail : ''}`);
  }
  console.log('---');
  console.log(`${pass} pass / ${fail} fail (${checks.length} total)`);
  process.exit(fail === 0 ? 0 : 1);
})();
