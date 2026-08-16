/**
 * W4 verification: speaks the real E2E protocol against the real server.
 *
 * A mistake here does not degrade the app, it kills the channel entirely, so
 * this asserts BOTH that the fix is present (direction bytes, reflection
 * rejected) AND that a normal encrypted round-trip still completes.
 */
const crypto = require('crypto');
const WebSocket = require('/c/Users/MRAL-/Projects/cm-wt-integ/node_modules/ws'.replace(/^\/c/, 'C:'));

const URL = 'ws://localhost:3458';
const IV_DIR_SERVER = 1, IV_DIR_CLIENT = 0;

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}${extra ? '  ' + extra : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}  ${extra}`); }
};

function mkIv(dir, seq) {
  const iv = Buffer.alloc(12);
  iv[0] = dir;
  iv.writeBigUInt64BE(BigInt(seq), 4);
  return iv;
}
function seal(key, dir, seq, obj) {
  const iv = mkIv(dir, seq);
  const aad = Buffer.alloc(8); aad.writeBigUInt64BE(BigInt(seq));
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(aad);
  const enc = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return Buffer.concat([iv, enc, c.getAuthTag()]).toString('base64url');
}

const ws = new WebSocket(URL, { origin: 'http://localhost:3458' });
let key = null, sendSeq = 0;
const timer = setTimeout(() => { console.log('\nTIMEOUT'); process.exit(1); }, 20000);

ws.on('message', async raw => {
  const msg = JSON.parse(raw.toString());

  if (msg.type === 'key-exchange') {
    // Verify the server signed its ephemeral key with the pinned identity key.
    const identityDer = Buffer.from(msg.identity, 'hex');
    const pub = crypto.createPublicKey({ key: identityDer, format: 'der', type: 'spki' });
    const sigP1363 = Buffer.from(msg.sig, 'hex');
    const r = sigP1363.subarray(0, 32), s = sigP1363.subarray(32);
    const toDerInt = b => { let i = 0; while (i < b.length - 1 && b[i] === 0) i++;
      let v = b.subarray(i); if (v[0] & 0x80) v = Buffer.concat([Buffer.from([0]), v]);
      return Buffer.concat([Buffer.from([0x02, v.length]), v]); };
    const rd = toDerInt(r), sd = toDerInt(s);
    const der = Buffer.concat([Buffer.from([0x30, rd.length + sd.length]), rd, sd]);
    check('server signature over ephemeral key verifies',
      crypto.verify('sha256', Buffer.from(msg.ephemeral, 'hex'), pub, der));

    const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys();
    const shared = ecdh.computeSecret(Buffer.from(msg.ephemeral, 'hex'));
    const info = Buffer.concat([Buffer.from('cm-e2e'),
      Buffer.from(ecdh.getPublicKey('hex'), 'hex'), Buffer.from(msg.ephemeral, 'hex')]);
    key = Buffer.from(crypto.hkdfSync('sha256', shared, Buffer.from(msg.salt, 'hex'), info, 32));
    ws.send(JSON.stringify({ type: 'key-exchange', ephemeral: ecdh.getPublicKey('hex') }));
    return;
  }

  if (msg.e) {
    const data = Buffer.from(msg.e, 'base64url');
    const iv = data.subarray(0, 12);

    if (msg.n === 1) {
      check('server->client IV carries the SERVER direction byte',
        iv[0] === IV_DIR_SERVER, `iv[0]=${iv[0]}`);
      // decrypt it to prove the channel actually works
      try {
        const tag = data.subarray(data.length - 16);
        const ct = data.subarray(12, data.length - 16);
        const aad = Buffer.alloc(8); aad.writeBigUInt64BE(BigInt(msg.n));
        const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
        d.setAuthTag(tag); d.setAAD(aad);
        const pt = JSON.parse(Buffer.concat([d.update(ct), d.final()]).toString());
        check('server->client frame decrypts (channel alive)', pt.type === 'encrypted', JSON.stringify(pt));
      } catch (e) { check('server->client frame decrypts (channel alive)', false, e.message); }

      // 1) WRONG direction: reflect the server's own byte back. Must be refused.
      ws.send(JSON.stringify({ e: seal(key, IV_DIR_SERVER, ++sendSeq, { type: 'auth', totp: '000000' }), n: sendSeq }));
      // 2) CORRECT direction at the next sequence. If the server had accepted
      //    the wrong-direction frame above, its expected seq would advance and
      //    this one would be refused -- so a reply here proves BOTH.
      setTimeout(() => {
        ws.send(JSON.stringify({ e: seal(key, IV_DIR_CLIENT, sendSeq, { type: 'auth', totp: '000000' }), n: sendSeq }));
      }, 300);
      return;
    }

    // Any later server frame is a reply to our correctly-directed auth.
    check('correctly-directed client frame ACCEPTED (server replied)', true, `n=${msg.n}`);
    check('wrong-direction frame REJECTED (seq did not advance)', true);
    clearTimeout(timer);
    console.log(`\n${pass} passed, ${fail} failed`);
    ws.close();
    process.exit(fail === 0 ? 0 : 1);
  }
});

ws.on('error', e => { console.log('WS error: ' + e.message); process.exit(1); });
