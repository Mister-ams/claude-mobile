#!/usr/bin/env node
/**
 * spike-herdr-subscription.js -- Wave 1 / S1, question 1.
 * Answers: is there a raw terminal-output stream we can subscribe to, or
 * only pattern-triggered notifications? Lists every subscription type and
 * the output-matched contract.
 */
const fs = require('fs');
const DEFS = '$' + 'defs';
const schema = JSON.parse(
  fs.readFileSync(process.argv[2] || '/tmp/herdr-spike/schema.json', 'utf8')
);
const d = schema.schemas.request[DEFS];

function consts(defName, key) {
  const node = d[defName];
  if (!node) return ['<' + defName + ' absent>'];
  return (node.oneOf || []).map((v) => {
    const c = v.properties && v.properties[key];
    const name = c && (c.const || (c.enum && c.enum.join('|')));
    const extra = Object.keys(v.properties || {})
      .filter((k) => k !== key)
      .join(',');
    return (name || '?') + (extra ? '   [' + extra + ']' : '');
  });
}

console.log('===== events.subscribe -- Subscription types =====');
const subs = consts('Subscription', 'type');
console.log('count=' + subs.length);
console.log(subs.join('\n'));

console.log('\n===== events.wait -- EventMatch types =====');
const em = consts('EventMatch', 'event');
console.log('count=' + em.length);
console.log(em.join('\n'));

console.log('\n===== pane.output_matched subscription params =====');
for (const v of (d.Subscription && d.Subscription.oneOf) || []) {
  const c = v.properties && v.properties.type;
  if (c && /output_matched|scroll|agent_status/.test(c.const || '')) {
    console.log('\n-- ' + c.const + ' --');
    console.log(JSON.stringify(v, null, 1));
  }
}

console.log('\n===== PaneWaitForOutputParams =====');
console.log(JSON.stringify(d.PaneWaitForOutputParams, null, 1));
