const express = require('express');
const { WebSocketServer } = require('ws');
const pty = require('node-pty');
const crypto = require('crypto');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const qrcode = require('qrcode-terminal');
const {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse
} = require('@simplewebauthn/server');
const { TOTP, Secret } = require('otpauth');

// ─── Config ──────────────────────────────────────────────────────
const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const PORT = process.env.PORT || config.port || 3456;
const MAX_SESSIONS = 8;
const SCROLLBACK_SIZE = 100000;

// ─── Auth: No tokens. Setup via localhost only. ──────────────────
const QRCode = require('qrcode');

function isSetupComplete() {
  return totpConfigured();
}

function isLocalhost(req) {
  const ip = req.ip || req.connection?.remoteAddress || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

// ─── TOTP (backup 2FA, works with Apple Passwords) ──────────────
const TOTP_PATH = path.join(__dirname, '.totp-secret');
let totpSecret = null;

function loadTotpSecret() {
  try {
    const data = JSON.parse(fs.readFileSync(TOTP_PATH, 'utf8'));
    totpSecret = data.secret;
  } catch {}
}

function totpConfigured() { return !!totpSecret; }

function generateTotpSecret() {
  const secret = new Secret();
  totpSecret = secret.base32;
  fs.writeFileSync(TOTP_PATH, JSON.stringify({ secret: totpSecret, created: new Date().toISOString() }));
  return totpSecret;
}

function verifyTotp(code) {
  if (!totpSecret) return false;
  const totp = new TOTP({ secret: Secret.fromBase32(totpSecret), digits: 6, period: 30 });
  const delta = totp.validate({ token: code, window: 1 });
  return delta !== null;
}

function getTotpUri() {
  if (!totpSecret) return null;
  const totp = new TOTP({
    issuer: 'ClaudeMobile',
    label: 'claude-mobile',
    secret: Secret.fromBase32(totpSecret),
    digits: 6, period: 30
  });
  return totp.toString();
}

loadTotpSecret();

// ─── Server Identity Key (P2: TOFU pinning) ────────────────────
const IDENTITY_KEY_PATH = path.join(__dirname, '.server-identity-key');
let identityKeys = null; // { publicKey, privateKey, fingerprint }

function loadOrCreateIdentityKey() {
  try {
    identityKeys = JSON.parse(fs.readFileSync(IDENTITY_KEY_PATH, 'utf8'));
    return;
  } catch {}
  // Generate new P-256 EC keypair
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const pubHex = publicKey.toString('hex');
  const fingerprint = crypto.createHash('sha256').update(publicKey).digest('hex');
  identityKeys = { publicKey: pubHex, privateKey, fingerprint, created: new Date().toISOString() };
  fs.writeFileSync(IDENTITY_KEY_PATH, JSON.stringify(identityKeys, null, 2));
  audit('CRYPTO', `Identity key generated. Fingerprint: ${fingerprint.slice(0, 16)}...`);
}

loadOrCreateIdentityKey();

// ─── E2E Encryption (P1: ECDH + AES-256-GCM) ───────────────────

// Convert DER-encoded ECDSA signature to IEEE P1363 (raw r||s) for Web Crypto
function derToP1363(derSig, keySize) {
  const n = keySize; // 32 bytes for P-256
  let offset = 2; // skip SEQUENCE tag + length
  if (derSig[1] & 0x80) offset += (derSig[1] & 0x7f); // long-form length
  // Read r
  offset++; // INTEGER tag
  let rLen = derSig[offset++];
  const rBytes = derSig.subarray(offset, offset + rLen);
  offset += rLen;
  // Read s
  offset++; // INTEGER tag
  let sLen = derSig[offset++];
  const sBytes = derSig.subarray(offset, offset + sLen);
  // Pad/trim to fixed size (remove leading zeros, pad to n bytes)
  const r = rBytes.length > n ? rBytes.subarray(rBytes.length - n) : Buffer.concat([Buffer.alloc(n - rBytes.length), rBytes]);
  const s = sBytes.length > n ? sBytes.subarray(sBytes.length - n) : Buffer.concat([Buffer.alloc(n - sBytes.length), sBytes]);
  return Buffer.concat([r, s]);
}

function initKeyExchange(ws) {
  // Generate ephemeral ECDH keypair
  const eph = crypto.createECDH('prime256v1');
  eph.generateKeys();
  const ephPubHex = eph.getPublicKey('hex');
  // Sign ephemeral pubkey with identity private key (red-team fix #1)
  // Convert from DER to P1363 format for Web Crypto compatibility
  const derSig = crypto.sign('sha256', Buffer.from(ephPubHex, 'hex'), identityKeys.privateKey);
  const sig = derToP1363(derSig, 32);
  // Random salt for HKDF
  const salt = crypto.randomBytes(32);
  ws._eph = eph;
  ws._salt = salt;
  ws.encrypted = false;
  ws._sendSeq = 0;
  ws._recvSeq = 0;
  ws._sessionKey = null;
  // Send key-exchange (plaintext -- only unencrypted message)
  ws.send(JSON.stringify({
    type: 'key-exchange',
    identity: identityKeys.publicKey,
    fingerprint: identityKeys.fingerprint,
    ephemeral: ephPubHex,
    sig: sig.toString('hex'),
    salt: salt.toString('hex'),
  }));
}

function completeKeyExchange(ws, clientEphPubHex) {
  if (!ws._eph) return false;
  try {
    const sharedSecret = ws._eph.computeSecret(Buffer.from(clientEphPubHex, 'hex'));
    const ephPubHex = ws._eph.getPublicKey('hex');
    // HKDF with salt and both pubkeys in info (red-team fix: key binding)
    const info = Buffer.concat([
      Buffer.from('cm-e2e'),
      Buffer.from(clientEphPubHex, 'hex'),
      Buffer.from(ephPubHex, 'hex'),
    ]);
    const key = crypto.hkdfSync('sha256', sharedSecret, ws._salt, info, 32);
    ws._sessionKey = Buffer.from(key);
    ws.encrypted = true;
    delete ws._eph;
    delete ws._salt;
    audit('CRYPTO', 'E2E session established', ws._ip);
    return true;
  } catch (e) {
    audit('CRYPTO', `Key exchange failed: ${e.message}`, ws._ip);
    return false;
  }
}

function secureSend(ws, obj) {
  if (!ws.encrypted || !ws._sessionKey) {
    // Pre-encryption: only key-exchange messages allowed
    ws.send(JSON.stringify(obj));
    return;
  }
  ws._sendSeq++;
  // Counter-based IV: 4-byte zero prefix + 8-byte big-endian counter
  const iv = Buffer.alloc(12);
  iv.writeBigUInt64BE(BigInt(ws._sendSeq), 4);
  const seqBuf = Buffer.alloc(8);
  seqBuf.writeBigUInt64BE(BigInt(ws._sendSeq));
  const cipher = crypto.createCipheriv('aes-256-gcm', ws._sessionKey, iv);
  cipher.setAAD(seqBuf);
  const plaintext = JSON.stringify(obj);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const payload = Buffer.concat([iv, encrypted, tag]).toString('base64url');
  ws.send(JSON.stringify({ e: payload, n: ws._sendSeq }));
}

function secureReceive(ws, rawStr) {
  let parsed;
  try { parsed = JSON.parse(rawStr); } catch { return null; }
  // Key exchange messages are always plaintext
  if (parsed.type === 'key-exchange') return parsed;
  // Encrypted message
  if (parsed.e) {
    if (!ws.encrypted || !ws._sessionKey) return null;
    // Replay protection: sequence must be strictly increasing
    if (parsed.n <= ws._recvSeq) {
      audit('SECURITY', `Replay detected: seq ${parsed.n} <= ${ws._recvSeq}`, ws._ip);
      return null;
    }
    try {
      const data = Buffer.from(parsed.e, 'base64url');
      const iv = data.subarray(0, 12);
      const tag = data.subarray(data.length - 16);
      const ciphertext = data.subarray(12, data.length - 16);
      const seqBuf = Buffer.alloc(8);
      seqBuf.writeBigUInt64BE(BigInt(parsed.n));
      const decipher = crypto.createDecipheriv('aes-256-gcm', ws._sessionKey, iv);
      decipher.setAuthTag(tag);
      decipher.setAAD(seqBuf);
      const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      ws._recvSeq = parsed.n;
      return JSON.parse(decrypted.toString('utf8'));
    } catch (e) {
      audit('CRYPTO', `Decrypt failed: ${e.message}`, ws._ip);
      return null;
    }
  }
  // Plaintext message post-handshake = anti-downgrade violation
  if (ws.encrypted) {
    audit('SECURITY', 'Plaintext message rejected (anti-downgrade)', ws._ip);
    return null;
  }
  return parsed;
}

// Session tokens: issued after auth, 30-min TTL, auto-rotated
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 min (short-lived, auto-refreshed)
const sessionTokens = new Map(); // token -> { expires, ip }

function issueSessionToken(ip) {
  const token = crypto.randomBytes(32).toString('base64url');
  sessionTokens.set(token, { expires: Date.now() + SESSION_TTL_MS, ip });
  return token;
}

function validateSessionToken(token, callerIP) {
  const entry = sessionTokens.get(token);
  if (!entry) return false;
  if (Date.now() > entry.expires) { sessionTokens.delete(token); return false; }
  if (callerIP && entry.ip && entry.ip !== callerIP) {
    audit('SECURITY', `Token IP mismatch: expected ${entry.ip}, got ${callerIP}`, callerIP);
    return false;
  }
  return true;
}

function rotateSessionToken(oldToken, ip) {
  const entry = sessionTokens.get(oldToken);
  if (!entry) return null;
  sessionTokens.delete(oldToken); // invalidate old token immediately
  const newToken = issueSessionToken(ip);
  audit('AUTH', `Token rotated`, ip);
  return newToken;
}

// Cleanup expired session tokens every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [token, entry] of sessionTokens) {
    if (now > entry.expires) sessionTokens.delete(token);
  }
}, 5 * 60 * 1000);

// ─── Global rate limiter ─────────────────────────────────────────
// 20 failures total (all IPs) in 5 min = 10 min global lockout
const GLOBAL_RATE_WINDOW = 5 * 60 * 1000;
const GLOBAL_RATE_MAX = 20;
const GLOBAL_LOCKOUT_MS = 10 * 60 * 1000;
let globalFailures = [];
let globalLockUntil = 0;

function checkGlobalRate() {
  if (Date.now() < globalLockUntil) return false;
  const cutoff = Date.now() - GLOBAL_RATE_WINDOW;
  globalFailures = globalFailures.filter(t => t > cutoff);
  return globalFailures.length < GLOBAL_RATE_MAX;
}

function recordGlobalFailure(ip) {
  globalFailures.push(Date.now());
  if (globalFailures.length >= GLOBAL_RATE_MAX) {
    globalLockUntil = Date.now() + GLOBAL_LOCKOUT_MS;
    audit('SECURITY', `Global lockout triggered. Last failure from ${ip}`);
  }
}

// ─── Per-IP rate limiter (defense in depth) ──────────────────────
const authAttempts = new Map();
const MAX_AUTH_ATTEMPTS = 5;
const AUTH_LOCKOUT_MS = 60000;

function checkIPRate(ip) {
  const entry = authAttempts.get(ip);
  if (!entry) return true;
  if (entry.lockUntil && Date.now() < entry.lockUntil) return false;
  if (entry.lockUntil && Date.now() >= entry.lockUntil) { authAttempts.delete(ip); return true; }
  return entry.count < MAX_AUTH_ATTEMPTS;
}

function recordIPFailure(ip) {
  const entry = authAttempts.get(ip) || { count: 0, lockUntil: null };
  entry.count++;
  if (entry.count >= MAX_AUTH_ATTEMPTS) {
    entry.lockUntil = Date.now() + AUTH_LOCKOUT_MS;
    audit('AUTH', `IP ${ip} locked out for 60s after ${entry.count} failures`);
  }
  authAttempts.set(ip, entry);
}

// Cleanup stale IP entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of authAttempts) {
    if (entry.lockUntil && now > entry.lockUntil + 60000) authAttempts.delete(ip);
  }
}, 5 * 60 * 1000);

// ─── Audit log ───────────────────────────────────────────────────
const AUDIT_PATH = path.join(os.homedir(), '.claude-mobile-audit.log');

function audit(category, message, ip) {
  const ts = new Date().toISOString();
  const line = `${ts} [${category}] ${ip ? `(${ip}) ` : ''}${message}\n`;
  try { fs.appendFileSync(AUDIT_PATH, line); } catch {}
  console.log(`  [audit] ${category}: ${message}`);
}

// ─── Env var whitelist for pty ───────────────────────────────────
const ENV_WHITELIST = [
  'PATH', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA',
  'SystemRoot', 'SystemDrive', 'TEMP', 'TMP', 'ComSpec',
  'HOMEDRIVE', 'HOMEPATH', 'USERNAME', 'OS', 'PROCESSOR_ARCHITECTURE',
  'NUMBER_OF_PROCESSORS', 'PATHEXT', 'PSModulePath',
  // Claude Code needs these
  'ANTHROPIC_API_KEY', 'CLAUDE_CODE_USE_BEDROCK',
  'NODE_PATH', 'npm_config_prefix',
];

function getSafeEnv() {
  const safe = {};
  for (const key of ENV_WHITELIST) {
    if (process.env[key]) safe[key] = process.env[key];
  }
  return safe;
}

// ─── Scrollback redaction ────────────────────────────────────────
const REDACT_PATTERNS = [
  /Bearer\s+[A-Za-z0-9._\-]+/g,
  /sk-[A-Za-z0-9]{20,}/g,
  /ghp_[A-Za-z0-9]{36}/g,
  /railway-[A-Za-z0-9\-]{20,}/g,
  /(password|passwd|secret|token|key)\s*[=:]\s*\S+/gi,
  /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END/g,
];

function redactSecrets(text) {
  let result = text;
  for (const pattern of REDACT_PATTERNS) {
    result = result.replace(pattern, '[REDACTED]');
  }
  return result;
}

// ─── Input canary detection ──────────────────────────────────────
const CANARY_PATTERNS = [
  /\/etc\/shadow/i,
  /PRIVATE\s*KEY/i,
  /AWS_SECRET/i,
  /curl\s.*\|\s*bash/i,
  /rm\s+-rf\s+[\/~]/i,
  /eval\s*\(/i,
];

function checkCanary(input) {
  for (const pattern of CANARY_PATTERNS) {
    if (pattern.test(input)) return pattern.source;
  }
  return null;
}

// ─── Auto-shutdown ───────────────────────────────────────────────
const AUTO_SHUTDOWN_MS = 8 * 60 * 60 * 1000; // 8 hours
let lastAuthenticatedActivity = Date.now();

setInterval(() => {
  if (Date.now() - lastAuthenticatedActivity > AUTO_SHUTDOWN_MS) {
    audit('SYSTEM', 'Auto-shutdown: no authenticated activity for 8 hours');
    process.exit(0);
  }
}, 60 * 1000);

// ─── WebAuthn / Passkey ──────────────────────────────────────────
const CRED_PATH = path.join(__dirname, '.credentials.json');
const RP_NAME = 'Claude Mobile';
let rpID = 'localhost';
let expectedOrigin = 'http://localhost:' + PORT;
let storedCredentials = [];

try {
  storedCredentials = JSON.parse(fs.readFileSync(CRED_PATH, 'utf8'));
} catch {}

function saveCredentials() {
  fs.writeFileSync(CRED_PATH, JSON.stringify(storedCredentials, null, 2));
}

// Active challenges for WebAuthn
const challenges = new Map(); // challengeId -> { challenge, expires }

// ─── Express ─────────────────────────────────────────────────────
const app = express();
app.use((req, res, next) => {
  if (req.path === '/api/upload') return next();
  express.json()(req, res, next);
});
app.use(express.static(path.join(__dirname, 'public')));

// ─── Localhost-only setup page ─────────────────────────────────
app.get('/setup', (req, res) => {
  if (!isLocalhost(req)) return res.status(403).send('Setup only available from localhost');
  if (isSetupComplete()) return res.send(`<h2>Setup already complete.</h2><p>TOTP configured. Use your phone to connect.</p><p style="margin-top:16px;font-family:monospace;font-size:12px;color:#8b949e">Server fingerprint:<br><code style="color:#58a6ff">${identityKeys.fingerprint}</code></p>`);
  res.send(`<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>Claude Mobile Setup</title>
<style>body{font-family:system-ui;background:#0d1117;color:#e6edf3;display:flex;flex-direction:column;align-items:center;padding:40px;gap:20px}
h1{font-size:22px}p{color:#8b949e;text-align:center;max-width:400px;line-height:1.6}.step{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:24px;text-align:center;max-width:400px;width:100%}
.step h2{font-size:16px;margin-bottom:12px}#qr{margin:16px auto}input{padding:12px;font-size:20px;text-align:center;width:180px;background:#0d1117;border:1px solid #30363d;border-radius:8px;color:#e6edf3;letter-spacing:8px}
button{padding:12px 24px;background:#ffd700;color:#0d1117;border:none;border-radius:8px;font-weight:700;font-size:16px;cursor:pointer;margin-top:12px}
button:hover{opacity:0.9}.ok{color:#3fb950;font-weight:600}.err{color:#f85149}</style></head>
<body><h1>Claude Mobile Setup</h1>
<p>This page is only accessible from your laptop. It sets up authentication for your phone.</p>
<div class="step"><h2>Step 1: Scan with Apple Passwords</h2>
<p>Open your iPhone camera and scan this QR code. Apple Passwords will offer to save the verification code.</p>
<div id="qr">Loading...</div>
<p style="font-size:12px;color:#8b949e">Or manually: Settings > Passwords > claude-mobile > Set Up Verification Code > Enter Setup Key</p>
<code id="secret" style="font-size:14px;background:#0d1117;padding:8px;border-radius:4px;display:block;margin:8px 0;letter-spacing:2px"></code>
</div>
<div class="step"><h2>Step 2: Verify</h2>
<p>Enter the 6-digit code from Apple Passwords:</p>
<input type="tel" id="code" maxlength="6" placeholder="000000">
<br><button onclick="verify()">Verify & Complete Setup</button>
<p id="result"></p></div>
<script>
fetch('/api/setup/init',{method:'POST'}).then(r=>r.json()).then(d=>{
  if(d.qr) document.getElementById('qr').innerHTML='<img src="'+d.qr+'" width="200" height="200">';
  if(d.secret) document.getElementById('secret').textContent=d.secret;
});
async function verify(){
  const code=document.getElementById('code').value.trim();
  if(code.length!==6)return;
  const r=await fetch('/api/setup/verify',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code})});
  const d=await r.json();
  document.getElementById('result').className=d.verified?'ok':'err';
  document.getElementById('result').textContent=d.verified?'Setup complete. Open the tunnel URL on your phone.':'Code incorrect. Try again.';
  if(d.verified) setTimeout(()=>location.reload(),2000);
}
document.getElementById('code').addEventListener('keydown',e=>{if(e.key==='Enter')verify()});
</script></body></html>`);
});

app.post('/api/setup/init', async (req, res) => {
  if (!isLocalhost(req)) return res.status(403).json({ error: 'Localhost only' });
  if (isSetupComplete()) return res.json({ error: 'Already configured' });
  const secret = totpConfigured() ? totpSecret : generateTotpSecret();
  const uri = getTotpUri();
  try {
    const qr = await QRCode.toDataURL(uri);
    audit('SETUP', 'TOTP QR generated on localhost');
    res.json({ qr, secret, uri });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/setup/verify', (req, res) => {
  if (!isLocalhost(req)) return res.status(403).json({ error: 'Localhost only' });
  if (verifyTotp(req.body.code)) {
    audit('SETUP', 'TOTP verified -- setup complete');
    res.json({ verified: true });
  } else {
    res.json({ verified: false });
  }
});

// Auth-gated config
app.get('/api/config', (req, res) => {
  if (!validateSessionToken(req.query.st, req.ip)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  res.json({ projects: config.projects, maxSessions: MAX_SESSIONS });
});

// WebAuthn registration
app.post('/api/passkey/register-options', async (req, res) => {
  if (!validateSessionToken(req.body.sessionToken, req.ip)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const options = await generateRegistrationOptions({
      rpName: RP_NAME, rpID,
      userName: 'owner',
      attestationType: 'none',
      authenticatorSelection: {
        authenticatorAttachment: 'platform',
        userVerification: 'required',
        residentKey: 'preferred',
      },
      excludeCredentials: storedCredentials.map(c => ({
        id: c.credentialID, type: 'public-key',
      })),
    });
    challenges.set(options.challenge, { challenge: options.challenge, expires: Date.now() + 120000 });
    res.json(options);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/passkey/register-verify', async (req, res) => {
  if (!validateSessionToken(req.body.sessionToken, req.ip)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const entry = challenges.get(req.body.expectedChallenge);
    if (!entry || Date.now() > entry.expires) {
      return res.status(400).json({ error: 'Challenge expired' });
    }
    const verification = await verifyRegistrationResponse({
      response: req.body.response,
      expectedChallenge: entry.challenge,
      expectedOrigin,
      expectedRPID: rpID,
    });
    if (verification.verified) {
      storedCredentials.push({
        credentialID: verification.registrationInfo.credential.id,
        credentialPublicKey: Buffer.from(verification.registrationInfo.credential.publicKey).toString('base64'),
        counter: verification.registrationInfo.credential.counter,
        created: new Date().toISOString(),
      });
      saveCredentials();
      challenges.delete(req.body.expectedChallenge);
      audit('AUTH', 'Passkey registered');
      res.json({ verified: true });
    } else {
      res.json({ verified: false });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/passkey/auth-options', async (_req, res) => {
  if (!storedCredentials.length) {
    return res.status(404).json({ error: 'No passkeys registered' });
  }
  try {
    const options = await generateAuthenticationOptions({
      rpID,
      allowCredentials: storedCredentials.map(c => ({
        id: c.credentialID, type: 'public-key',
      })),
      userVerification: 'required',
    });
    challenges.set(options.challenge, { challenge: options.challenge, expires: Date.now() + 120000 });
    res.json(options);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/passkey/auth-verify', async (req, res) => {
  try {
    const entry = challenges.get(req.body.expectedChallenge);
    if (!entry || Date.now() > entry.expires) {
      return res.status(400).json({ error: 'Challenge expired' });
    }
    const cred = storedCredentials.find(c => c.credentialID === req.body.response.id);
    if (!cred) return res.status(400).json({ error: 'Unknown credential' });

    const verification = await verifyAuthenticationResponse({
      response: req.body.response,
      expectedChallenge: entry.challenge,
      expectedOrigin,
      expectedRPID: rpID,
      credential: {
        id: cred.credentialID,
        publicKey: Buffer.from(cred.credentialPublicKey, 'base64'),
        counter: cred.counter,
      },
    });
    if (verification.verified) {
      cred.counter = verification.authenticationInfo.newCounter;
      saveCredentials();
      challenges.delete(req.body.expectedChallenge);
      const ip = req.ip || 'unknown';
      const sessionToken = issueSessionToken(ip);
      audit('AUTH', `Passkey authentication successful`, ip);
      res.json({ verified: true, sessionToken });
    } else {
      res.json({ verified: false });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Token refresh -- deprecated (use WebSocket refresh path for E2E encryption)
app.post('/api/auth/refresh', (_req, res) => {
  res.status(410).json({ error: 'Deprecated. Use WebSocket refresh for E2E encrypted rotation.' });
});

// Kill switch
app.post('/api/kill', (req, res) => {
  if (!validateSessionToken(req.body.sessionToken, req.ip)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  audit('SYSTEM', 'Remote kill switch activated', req.ip);
  res.json({ status: 'shutting down' });
  setTimeout(() => process.exit(0), 500);
});

// Auth status
app.get('/api/auth/status', (_req, res) => {
  res.json({
    hasPasskey: storedCredentials.length > 0,
    hasTotp: totpConfigured(),
    setupDone: isSetupComplete(),
    serverFingerprint: identityKeys?.fingerprint || null,
  });
});

// TOTP setup (requires session token -- bootstrap or passkey authed)
app.post('/api/totp/setup', (req, res) => {
  if (!validateSessionToken(req.body.sessionToken, req.ip)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (totpConfigured()) {
    return res.json({ already: true, uri: getTotpUri() });
  }
  generateTotpSecret();
  audit('AUTH', 'TOTP secret generated');
  res.json({ uri: getTotpUri(), secret: totpSecret });
});

app.post('/api/totp/verify-setup', (req, res) => {
  if (!validateSessionToken(req.body.sessionToken, req.ip)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (verifyTotp(req.body.code)) {
    audit('AUTH', 'TOTP setup verified');
    res.json({ verified: true });
  } else {
    res.json({ verified: false });
  }
});

// ─── Image Upload ─────────────────────────────────────────────
const UPLOAD_DIR = path.join(os.tmpdir(), 'claude-mobile-uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

app.post('/api/upload', express.raw({ type: '*/*', limit: '10mb' }), (req, res) => {
  const token = req.headers['x-session-token'];
  if (!validateSessionToken(token, req.ip)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const buf = req.body;
  if (!buf || !buf.length) {
    return res.status(400).json({ error: 'No file data received' });
  }
  const ct = req.headers['content-type'] || '';
  const ext = ct.includes('png') ? '.png' : ct.includes('jpeg') || ct.includes('jpg') ? '.jpg' : ct.includes('webp') ? '.webp' : '.png';
  const filename = `screenshot-${Date.now()}${ext}`;
  const filepath = path.join(UPLOAD_DIR, filename);
  fs.writeFileSync(filepath, buf);
  audit('UPLOAD', `Image uploaded: ${filename}`, req.ip);
  res.json({ path: filepath, filename });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// ─── Sessions ────────────────────────────────────────────────────
const sessions = new Map();
let nextId = 0;

function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '').replace(/\x1b[^[]/g, '');
}

// Accumulate recent output for better attention detection
let recentOutput = new Map(); // session id -> last N chars of output

function updateRecentOutput(sessionId, data) {
  const existing = recentOutput.get(sessionId) || '';
  const combined = existing + data;
  // Keep last 2KB for pattern matching
  recentOutput.set(sessionId, combined.length > 2048 ? combined.slice(-2048) : combined);
}

function detectAttention(sessionId) {
  const raw = recentOutput.get(sessionId) || '';
  const clean = stripAnsi(raw);
  const lines = clean.split('\n').filter(l => l.trim());
  const last5 = lines.slice(-5).join('\n');
  const lastLine = lines[lines.length - 1] || '';

  // Permission prompts -- Claude Code tool approval
  if (/Allow|Deny|Don't allow|allow this|for this session|always allow/i.test(last5)) return 'permission';

  // Yes/No prompts
  if (/\(y\/n\)/i.test(last5)) return 'permission';

  // Question directed at user (line ending with ?)
  // Only trigger if it's near the bottom of output (last 3 lines)
  const last3 = lines.slice(-3).join('\n');
  if (/\?\s*$/.test(last3) && !/^\s*(http|\/\/|#)/.test(lastLine)) return 'question';

  // Claude Code idle prompt -- waiting for user input
  // The prompt character > appears as the last meaningful character
  if (/^\s*[>]\s*$/.test(lastLine)) return 'ready';
  // Also check for the Unicode prompt character
  if (/^\s*[>\u276f\u2771]\s*$/.test(lastLine)) return 'ready';

  // Claude finished responding -- look for cost/token summary lines
  // which appear at the end of a response
  if (/total cost|tokens used|input:|output:/i.test(last3)) return 'ready';

  return null;
}

function getSessionList() {
  return Array.from(sessions.values()).map(s => ({
    id: s.id, name: s.name, dir: s.dir, attention: s.attention,
    viewers: s.clients.size
  }));
}

function broadcastSessions() {
  const obj = { type: 'sessions', sessions: getSessionList() };
  for (const client of allClients) {
    if (client.authenticated && client.readyState === 1) secureSend(client, obj);
  }
}

function broadcastAttention(sessionId, reason) {
  const obj = { type: 'attention', session: sessionId, reason };
  for (const client of allClients) {
    if (client.authenticated && client.readyState === 1) secureSend(client, obj);
  }
}

function createSession(name, dir) {
  if (sessions.size >= MAX_SESSIONS) return null;
  const id = nextId++;
  const proc = pty.spawn('cmd.exe', ['/c', 'claude'], {
    name: 'xterm-256color', cols: 80, rows: 24,
    cwd: dir, env: getSafeEnv()  // Phase 2: restricted env
  });

  const session = {
    id, name, dir, proc, scrollback: '',
    attention: null, attentionTimer: null, clients: new Set()
  };

  proc.onData((data) => {
    session.scrollback += data;
    if (session.scrollback.length > SCROLLBACK_SIZE) {
      session.scrollback = session.scrollback.slice(-SCROLLBACK_SIZE);
    }
    updateRecentOutput(id, data);

    // Clear attention when new output arrives (Claude is responding)
    if (session.attention) { session.attention = null; broadcastSessions(); }

    const obj = { type: 'output', session: id, data };
    for (const ws of session.clients) {
      if (ws.readyState === 1) secureSend(ws, obj);
    }

    // Debounce: wait for output to settle, then check accumulated buffer
    if (session.attentionTimer) clearTimeout(session.attentionTimer);
    session.attentionTimer = setTimeout(() => {
      const reason = detectAttention(id);
      if (reason) {
        session.attention = reason;
        broadcastAttention(id, reason);
        broadcastSessions();
      }
      // Clear recent output after detection (start fresh for next cycle)
      recentOutput.delete(id);
    }, 3000);
  });

  proc.onExit(() => {
    if (session.attentionTimer) clearTimeout(session.attentionTimer);
    recentOutput.delete(id);
    sessions.delete(id);
    broadcastSessions();
  });

  sessions.set(id, session);
  audit('SESSION', `Created: "${name}" in ${dir}`);
  return session;
}

// ─── WebSocket ───────────────────────────────────────────────────
const allClients = new Set();
const MAX_CONNECTIONS_PER_IP = 10;

function getClientIP(ws) {
  // X-Forwarded-For from WS upgrade request (ngrok sets this)
  const xff = ws._req?.headers?.['x-forwarded-for'];
  if (xff) return xff.split(',')[0].trim();
  return ws._socket?._peername?.address || 'unknown';
}

wss.on('connection', (ws, req) => {
  ws._req = req; // store upgrade request for X-Forwarded-For
  const ip = getClientIP(ws);
  const ipCount = [...allClients].filter(c => c._ip === ip).length;
  if (ipCount >= MAX_CONNECTIONS_PER_IP) {
    ws.close(1013, 'Too many connections');
    audit('SECURITY', `Connection rejected: too many from ${ip}`, ip);
    return;
  }
  ws.authenticated = false;
  ws.currentSession = null;
  ws._ip = ip;
  ws._sessionToken = null;
  allClients.add(ws);
  audit('CONNECT', `WebSocket opened`, ip);

  // Initiate E2E key exchange immediately
  initKeyExchange(ws);

  // Anti-downgrade: close if not encrypted within 10 seconds
  const encryptionTimeout = setTimeout(() => {
    if (!ws.encrypted) {
      audit('SECURITY', 'Encryption timeout -- closing connection', ws._ip);
      ws.close(1008, 'Encryption required');
    }
  }, 10000);

  ws.on('message', (raw) => {
    const msg = secureReceive(ws, raw.toString());
    if (!msg) return;

    // ── Key exchange (E2E handshake) ──
    if (msg.type === 'key-exchange') {
      if (msg.ephemeral && !ws.encrypted) {
        if (completeKeyExchange(ws, msg.ephemeral)) {
          clearTimeout(encryptionTimeout);
          secureSend(ws, { type: 'encrypted', status: 'ok' });
        } else {
          ws.close(1008, 'Key exchange failed');
        }
      }
      return;
    }

    // Anti-downgrade: reject all non-key-exchange messages before encryption
    if (!ws.encrypted) {
      ws.close(1008, 'Encryption required');
      return;
    }

    // ── Auth via TOTP (backup 2FA) or session token re-auth ──
    if (msg.type === 'auth') {
      if (!checkGlobalRate() || !checkIPRate(ws._ip)) {
        secureSend(ws, { type: 'auth', success: false, locked: true });
        return;
      }
      const setupDone = isSetupComplete();
      const authState = { setupDone, hasPasskey: storedCredentials.length > 0, hasTotp: totpConfigured() };

      // Not set up yet -- reject all remote auth
      if (!setupDone) {
        secureSend(ws, { type: 'auth', success: false, ...authState, reason: 'Setup required. Open http://localhost:' + PORT + '/setup on the laptop.' });
        return;
      }

      // Session token re-auth (reconnect)
      if (msg.sessionToken && validateSessionToken(msg.sessionToken, ws._ip)) {
        ws.authenticated = true;
        ws._sessionToken = msg.sessionToken;
        lastAuthenticatedActivity = Date.now();
        audit('AUTH', `Session token re-auth`, ws._ip);
        secureSend(ws, { type: 'auth', success: true, sessionToken: msg.sessionToken, ...authState });
        secureSend(ws, { type: 'sessions', sessions: getSessionList() });
        return;
      }

      // TOTP auth
      if (msg.totp && verifyTotp(msg.totp)) {
        ws.authenticated = true;
        const st = issueSessionToken(ws._ip);
        ws._sessionToken = st;
        authAttempts.delete(ws._ip);
        lastAuthenticatedActivity = Date.now();
        audit('AUTH', `TOTP auth successful`, ws._ip);
        secureSend(ws, { type: 'auth', success: true, sessionToken: st, ...authState });
        secureSend(ws, { type: 'sessions', sessions: getSessionList() });
        return;
      }

      recordIPFailure(ws._ip);
      recordGlobalFailure(ws._ip);
      audit('AUTH', `Failed auth attempt`, ws._ip);
      secureSend(ws, { type: 'auth', success: false, ...authState });
      return;
    }

    // ── Auth via passkey (session token from HTTP auth flow) ──
    if (msg.type === 'auth-passkey') {
      if (msg.sessionToken && validateSessionToken(msg.sessionToken, ws._ip)) {
        ws.authenticated = true;
        ws._sessionToken = msg.sessionToken;
        lastAuthenticatedActivity = Date.now();
        secureSend(ws, { type: 'auth', success: true, sessionToken: msg.sessionToken, hasPasskey: true });
        secureSend(ws, { type: 'sessions', sessions: getSessionList() });
      } else {
        secureSend(ws, { type: 'auth', success: false });
      }
      return;
    }

    // ── Token refresh over WebSocket ──
    if (msg.type === 'refresh') {
      if (ws.authenticated && ws._sessionToken && validateSessionToken(ws._sessionToken, ws._ip)) {
        const newToken = rotateSessionToken(ws._sessionToken, ws._ip);
        if (newToken) {
          ws._sessionToken = newToken;
          secureSend(ws, { type: 'refreshed', sessionToken: newToken, ttl: SESSION_TTL_MS });
        }
      }
      return;
    }

    if (!ws.authenticated) {
      secureSend(ws, { type: 'error', message: 'Not authenticated' });
      return;
    }

    // Check session token still valid
    if (ws._sessionToken && !validateSessionToken(ws._sessionToken, ws._ip)) {
      ws.authenticated = false;
      secureSend(ws, { type: 'expired' });
      audit('AUTH', `Session expired`, ws._ip);
      return;
    }

    lastAuthenticatedActivity = Date.now();

    switch (msg.type) {
      case 'create': {
        const dir = msg.dir || config.projects[0].dir;
        const allowedDirs = config.projects.map(p => p.dir);
        if (!allowedDirs.includes(dir)) {
          secureSend(ws, { type: 'error', message: 'Directory not in allowed project list' });
          break;
        }
        const session = createSession(msg.name || 'Session', dir);
        if (session) {
          broadcastSessions();
          secureSend(ws, { type: 'created', session: session.id });
        } else {
          secureSend(ws, { type: 'error', message: 'Max sessions reached (4)' });
        }
        break;
      }

      case 'connect': {
        const session = sessions.get(msg.session);
        if (!session) break;
        if (ws.currentSession !== null) {
          sessions.get(ws.currentSession)?.clients.delete(ws);
        }
        ws.currentSession = msg.session;
        session.clients.add(ws);
        if (session.scrollback) {
          // Phase 2: redact secrets from scrollback
          const safe = redactSecrets(session.scrollback);
          secureSend(ws, { type: 'scrollback', session: session.id, data: safe });
        }
        if (session.attention) {
          secureSend(ws, { type: 'attention', session: session.id, reason: session.attention });
        }
        break;
      }

      case 'input': {
        const session = ws.currentSession !== null ? sessions.get(ws.currentSession) : null;
        if (session) {
          // Phase 2: canary detection
          const canary = checkCanary(msg.data);
          if (canary) {
            audit('CANARY', `Suspicious input detected: ${canary}`, ws._ip);
            secureSend(ws, { type: 'warning', message: `Canary triggered: ${canary}` });
          }
          const inputHash = crypto.createHash('sha256').update(msg.data).digest('hex').slice(0, 12);
          audit('INPUT', `session=${ws.currentSession} len=${msg.data.length} hash=${inputHash}`, ws._ip);
          try { session.proc.write(msg.data); } catch (e) {
            audit('ERROR', `pty write: ${e.message}`);
          }
          if (session.attention) { session.attention = null; broadcastSessions(); }
        }
        break;
      }

      case 'resize': {
        const session = ws.currentSession !== null ? sessions.get(ws.currentSession) : null;
        if (session && msg.cols && msg.rows) {
          // Phase 2: bounds checking
          const cols = Math.max(40, Math.min(300, msg.cols));
          const rows = Math.max(10, Math.min(200, msg.rows));
          try { session.proc.resize(cols, rows); } catch {}
        }
        break;
      }

      case 'rename': {
        const session = sessions.get(msg.session);
        if (session && msg.name) {
          // Phase 2: name validation
          const name = String(msg.name).slice(0, 50).replace(/[<>"'&]/g, '');
          session.name = name;
          broadcastSessions();
        }
        break;
      }

      case 'close': {
        const session = sessions.get(msg.session);
        if (session) {
          try { session.proc.kill(); } catch {}
          if (session.attentionTimer) clearTimeout(session.attentionTimer);
          sessions.delete(msg.session);
          if (ws.currentSession === msg.session) ws.currentSession = null;
          broadcastSessions();
          audit('SESSION', `Closed: "${session.name}"`, ws._ip);
        }
        break;
      }
    }
  });

  ws.on('close', () => {
    allClients.delete(ws);
    if (ws.currentSession !== null) {
      sessions.get(ws.currentSession)?.clients.delete(ws);
    }
    audit('CONNECT', `WebSocket closed`, ws._ip);
  });
});

// ─── Session expiry checker (every 60s) ──────────────────────────
setInterval(() => {
  for (const ws of allClients) {
    if (ws.authenticated && ws._sessionToken && !validateSessionToken(ws._sessionToken, ws._ip)) {
      ws.authenticated = false;
      secureSend(ws, { type: 'expired' });
      audit('AUTH', `Session auto-expired`, ws._ip);
    }
  }
}, 60 * 1000);

// ─── Startup ─────────────────────────────────────────────────────
function getLocalIP() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return 'localhost';
}

function autoStartSessions() {
  const autoStart = config.autoStart || [];
  for (const name of autoStart) {
    const project = config.projects.find(p => p.name === name);
    if (project && fs.existsSync(project.dir)) {
      const session = createSession(project.name, project.dir);
      if (session) console.log(`  Auto-started: ${project.name}`);
    }
  }
}

// ngrok with permanent static domain
const NGROK_DOMAIN = config.ngrokDomain || 'frida-noninferable-alexandria.ngrok-free.dev';

function startTunnel() {
  // Find ngrok
  const ngrokCandidates = [
    'ngrok',
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Packages',
      'Ngrok.Ngrok_Microsoft.Winget.Source_8wekyb3d8bbwe', 'ngrok.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'ngrok', 'ngrok.exe'),
  ];
  let ngrokPath = 'ngrok';
  for (const c of ngrokCandidates) {
    if (c && fs.existsSync(c)) { ngrokPath = c; break; }
  }

  const tunnelUrl = `https://${NGROK_DOMAIN}`;
  // Set WebAuthn origin for passkey support (stable domain!)
  rpID = NGROK_DOMAIN;
  expectedOrigin = tunnelUrl;

  const ng = spawn(ngrokPath, ['http', '--url', NGROK_DOMAIN, String(PORT)], {
    stdio: ['ignore', 'pipe', 'pipe']
  });

  ng.stderr.on('data', (data) => {
    const line = data.toString().trim();
    if (line) console.log(`  [ngrok] ${line}`);
  });

  ng.on('error', (err) => {
    console.log(`  Tunnel: ngrok not found (${err.message}), local only`);
    showLocalQR();
  });

  ng.on('exit', (code) => {
    if (code) console.log(`  Tunnel: ngrok exited (code ${code})`);
  });

  // ngrok doesn't print the URL when using --domain, we already know it
  setTimeout(() => {
    console.log('');
    console.log(`  Tunnel:   ${tunnelUrl}`);
    console.log(`  Passkey:  rpID=${rpID} (permanent)`);
    console.log('');
    console.log('  Scan to connect:');
    qrcode.generate(tunnelUrl, { small: true }, (code) => { console.log(code); });
  }, 2000);
}

function showLocalQR() {
  const ip = getLocalIP();
  qrcode.generate(`http://${ip}:${PORT}`, { small: true }, (code) => { console.log(code); });
}

server.listen(PORT, '0.0.0.0', () => {
  const ip = getLocalIP();
  console.log('');
  console.log('  Claude Mobile Bridge (zero-trust)');
  console.log('  ────────────────────────────────');
  console.log(`  Local:    http://localhost:${PORT}`);
  if (isSetupComplete()) {
    console.log(`  Auth:     TOTP configured, passkeys: ${storedCredentials.length}`);
    console.log(`  Status:   Ready for remote connections`);
  } else {
    console.log(`  Auth:     NOT CONFIGURED`);
    console.log(`  Setup:    http://localhost:${PORT}/setup`);
    console.log(`            (laptop only -- open this URL to configure)`);
  }
  console.log(`  Identity: ${identityKeys.fingerprint.slice(0, 16)}...`);
  console.log(`  Audit:    ${AUDIT_PATH}`);
  console.log(`  Shutdown: auto after 8h idle`);
  console.log('  ────────────────────────────────');
  autoStartSessions();
  audit('SYSTEM', `Server started on port ${PORT}`);
  console.log('');
  console.log('  Starting tunnel...');
  startTunnel();
});
