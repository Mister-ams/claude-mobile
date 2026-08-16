#!/usr/bin/env node
/**
 * spike-herdr-schema.js -- Wave 1 / S1, question 1 (stream fidelity).
 *
 * Static inspection of herdr's own bundled socket-API schema. Answers
 * "what shape does the API actually return" without guessing.
 *
 * Usage (inside WSL Ubuntu-24.04):
 *   herdr api schema --json > /tmp/herdr-spike/schema.json
 *   node spike-herdr-schema.js /tmp/herdr-spike/schema.json [section]
 *
 * Sections: methods | read | events | grid | all (default)
 */
const fs = require('fs');

const DEFS = '$' + 'defs';
const REF = '$' + 'ref';

const path = process.argv[2] || '/tmp/herdr-spike/schema.json';
const section = process.argv[3] || 'all';
const schema = JSON.parse(fs.readFileSync(path, 'utf8'));

function defsOf(name) {
  return (schema.schemas[name] && schema.schemas[name][DEFS]) || {};
}

function header(t) {
  console.log('\n===== ' + t + ' =====');
}

function methods() {
  header('REQUEST METHODS (protocol ' + schema.protocol + ')');
  const req = schema.schemas.request;
  const out = [];
  for (const v of req.oneOf || []) {
    const m = v.properties && v.properties.method;
    const name = m && (m.const || (m.enum && m.enum[0]));
    const p = v.properties && v.properties.params;
    const pref = p && p[REF] ? p[REF].split('/').pop() : '';
    if (name) out.push(name + (pref ? '  <- ' + pref : ''));
  }
  console.log('count=' + out.length);
  console.log(out.sort().join('\n'));
}

function read() {
  header('READ / INPUT CONTRACT');
  const d = defsOf('request');
  for (const k of [
    'ReadFormat',
    'ReadSource',
    'PaneReadParams',
    'AgentReadParams',
    'PaneSendTextParams',
    'PaneSendKeysParams',
    'PaneSendInputParams',
    'AgentPromptParams',
  ]) {
    console.log('\n-- ' + k + ' --');
    console.log(d[k] ? JSON.stringify(d[k], null, 1) : 'ABSENT');
  }
  header('READ RESULT SHAPE (success_response)');
  const sd = defsOf('success_response');
  for (const k of Object.keys(sd)) {
    if (/read|output|screen|cell|grid|line/i.test(k)) {
      console.log('\n-- ' + k + ' --');
      console.log(JSON.stringify(sd[k], null, 1));
    }
  }
}

function events() {
  header('SUBSCRIPTION EVENT VARIANTS');
  const se = schema.schemas.subscription_event;
  console.log('top-level props: ' + JSON.stringify(se.properties));
  console.log('required: ' + JSON.stringify(se.required));
  const d = se[DEFS] || {};
  console.log('\ndefs (' + Object.keys(d).length + '):');
  for (const k of Object.keys(d).sort()) {
    const props = d[k].properties ? Object.keys(d[k].properties).join(',') : '';
    const en = d[k].enum ? 'enum[' + d[k].enum.join('|') + ']' : '';
    console.log('  ' + k + '  ' + (en || props));
  }
  header('events.subscribe PARAMS');
  const rd = defsOf('request');
  for (const k of Object.keys(rd)) {
    if (/EventsSubscribe|EventsWait|EventKind|EventFilter/i.test(k)) {
      console.log('\n-- ' + k + ' --');
      console.log(JSON.stringify(rd[k], null, 1));
    }
  }
}

function grid() {
  header('GRID / STYLE / HYPERLINK SEARCH (whole schema, case-insensitive)');
  const needles = [
    'hyperlink',
    'osc8',
    'osc_8',
    'url_id',
    'urlid',
    'cell',
    'grid',
    'sgr',
    'fg',
    'bg',
    'bold',
    'italic',
    'reverse',
    'underline',
    'style',
    'attr',
    'rgb',
    'color',
  ];
  const blob = JSON.stringify(schema);
  for (const n of needles) {
    const re = new RegExp('"[^"]*' + n + '[^"]*"', 'gi');
    const hits = [...new Set(blob.match(re) || [])];
    console.log(
      n.padEnd(10) + ' hits=' + hits.length + (hits.length ? '  ' + hits.slice(0, 12).join(' ') : '')
    );
  }
}

if (section === 'methods' || section === 'all') methods();
if (section === 'read' || section === 'all') read();
if (section === 'events' || section === 'all') events();
if (section === 'grid' || section === 'all') grid();
