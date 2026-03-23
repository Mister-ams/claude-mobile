const express = require('express');
const { WebSocketServer } = require('ws');
const pty = require('node-pty');
const { execSync } = require('child_process');
const crypto = require('crypto');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse
} = require('@simplewebauthn/server');
const { TOTP, Secret } = require('otpauth');

// ─── Config ──────────────────────────────────────────────────────
const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const PORT = process.env.PORT || config.port || 3456;
const MAX_SESSIONS = 8;
const SCROLLBACK_SIZE = 400000;

// ─── dtach session persistence (via WSL) ─────────────────────────
const WSL_DISTRO = config.wslDistro || 'Ubuntu-24.04';
const DTACH_PREFIX = 'cm'; // socket files: /tmp/cm-0.dtach, cm-1.dtach, ...

function wslExec(cmd) {
  return execSync(`wsl -d ${WSL_DISTRO} -u root -- bash -c "${cmd.replace(/"/g, '\\"')}"`, {
    encoding: 'utf8', timeout: 10000
  }).trim();
}

function winPathToWsl(winPath) {
  return winPath
    .replace(/^([A-Za-z]):\\/, (_, d) => `/mnt/${d.toLowerCase()}/`)
    .replace(/\\/g, '/');
}

function wslPathToWin(wslPath) {
  return wslPath
    .replace(/^\/mnt\/([a-z])\//, (_, d) => `${d.toUpperCase()}:\\`)
    .replace(/\//g, '\\');
}

function dtachSocket(id) { return `/tmp/${DTACH_PREFIX}-${id}.dtach`; }
function dtachSocketName(id) { return `${DTACH_PREFIX}-${id}`; }

function listDtachSessions() {
  try {
    const out = wslExec(`ls /tmp/${DTACH_PREFIX}-*.dtach 2>/dev/null || true`);
    if (!out) return [];
    return out.split('\n').filter(Boolean).map(p => {
      const match = p.match(/cm-(\d+)\.dtach$/);
      return match ? parseInt(match[1]) : null;
    }).filter(id => id !== null);
  } catch { return []; }
}

function createDtachSession(id, wslDir, cols, rows) {
  const socket = dtachSocket(id);
  const c = Math.max(10, Math.min(500, parseInt(cols, 10) || 50));
  const r = Math.max(5, Math.min(200, parseInt(rows, 10) || 30));
  // dtach -n creates a new session in background (-z disables suspend)
  // TERM must be set for Claude Code TUI rendering
  wslExec(`cd '${wslDir}' && TERM=xterm-256color dtach -n ${socket} -z bash -c 'cmd.exe /c claude'`);
}

function attachToDtach(id, cols, rows) {
  const socket = dtachSocket(id);
  return pty.spawn('wsl.exe', [
    '-d', WSL_DISTRO, '-u', 'root', '--',
    'dtach', '-a', socket
  ], {
    name: 'xterm-256color', cols: cols || 80, rows: rows || 24,
    env: getSafeEnv()
  });
}

function dtachSessionAlive(id) {
  const socket = dtachSocket(id);
  try {
    // Check socket file exists and process is alive
    wslExec(`test -S ${socket} && dtach -a ${socket} -E 2>/dev/null`);
    return true;
  } catch {
    // Socket file might exist but be stale -- check if it's there at all
    try { wslExec(`test -S ${socket}`); return true; }
    catch { return false; }
  }
}

function killDtachSession(id) {
  const socket = dtachSocket(id);
  try {
    // Find and kill the process attached to this socket
    const pid = wslExec(`lsof -t ${socket} 2>/dev/null || true`);
    if (pid) wslExec(`kill ${pid} 2>/dev/null || true`);
    wslExec(`rm -f ${socket}`);
  } catch {}
}

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
const INACTIVITY_MS = (config.inactivityTimeout || 15) * 60 * 1000;
const sessionTokens = new Map(); // token -> { expires, ip, lastActivity }

function issueSessionToken(ip) {
  const token = crypto.randomBytes(32).toString('base64url');
  sessionTokens.set(token, { expires: Date.now() + SESSION_TTL_MS, ip, lastActivity: Date.now() });
  return token;
}

function touchTokenActivity(token) {
  const entry = sessionTokens.get(token);
  if (entry) entry.lastActivity = Date.now();
}

function isTokenInactive(token) {
  const entry = sessionTokens.get(token);
  if (!entry) return false;
  return (Date.now() - entry.lastActivity) > INACTIVITY_MS;
}

function validateSessionToken(token, callerIP) {
  const entry = sessionTokens.get(token);
  if (!entry) return false;
  if (Date.now() > entry.expires) { sessionTokens.delete(token); return false; }
  // Skip IP check if token was issued with unknown IP (WS behind proxy)
  if (callerIP && entry.ip && entry.ip !== 'unknown' && entry.ip !== callerIP) {
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
// Trust X-Forwarded-For from loopback (tailscale serve proxies HTTPS -> localhost)
app.set('trust proxy', 'loopback');
app.use((req, res, next) => {
  if (req.path === '/api/upload') return next();
  express.json()(req, res, next);
});
app.use((_req, res, next) => {
  res.setHeader('Content-Security-Policy', [
    "default-src 'none'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "connect-src 'self' ws: wss:",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; '));
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  next();
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

// Auth middleware for HTTP routes
function requireSession(req, res, next) {
  const token = req.headers['x-session-token'] || req.body?.sessionToken || req.query?.st;
  if (!validateSessionToken(token, req.ip)) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// Auth-gated config
app.get('/api/config', requireSession, (req, res) => {
  res.json({ projects: config.projects, maxSessions: MAX_SESSIONS });
});

// WebAuthn registration
app.post('/api/passkey/register-options', requireSession, async (req, res) => {
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

app.post('/api/passkey/register-verify', requireSession, async (req, res) => {
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

app.post('/api/passkey/auth-options', async (req, res) => {
  const ip = req.ip || 'unknown';
  if (!checkGlobalRate() || !checkIPRate(ip)) {
    return res.status(429).json({ error: 'Too many attempts' });
  }
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
  const ip = req.ip || 'unknown';
  if (!checkGlobalRate() || !checkIPRate(ip)) {
    return res.status(429).json({ error: 'Too many attempts' });
  }
  try {
    const entry = challenges.get(req.body.expectedChallenge);
    if (!entry || Date.now() > entry.expires) {
      recordIPFailure(ip);
      return res.status(400).json({ error: 'Challenge expired' });
    }
    const cred = storedCredentials.find(c => c.credentialID === req.body.response.id);
    if (!cred) { recordIPFailure(ip); return res.status(400).json({ error: 'Unknown credential' }); }

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
app.post('/api/kill', requireSession, (req, res) => {
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
app.post('/api/totp/setup', requireSession, (req, res) => {
  if (totpConfigured()) {
    return res.json({ already: true, uri: getTotpUri() });
  }
  generateTotpSecret();
  audit('AUTH', 'TOTP secret generated');
  res.json({ uri: getTotpUri(), secret: totpSecret });
});

app.post('/api/totp/verify-setup', requireSession, (req, res) => {
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
  audit('UPLOAD', `Attempt: ip=${req.ip} token=${token ? token.slice(0, 8) + '...' : 'NONE'} size=${req.headers['content-length'] || '?'}`, req.ip);
  if (!validateSessionToken(token, req.ip)) {
    audit('UPLOAD', `Rejected: token invalid or IP mismatch`, req.ip);
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
const wss = new WebSocketServer({ server, maxPayload: 1024 * 1024 }); // 1MB max message

// ─── Sessions ────────────────────────────────────────────────────
const sessions = new Map();
let nextId = 0;

// ─── Session metadata persistence (names survive restart) ────────
const SESSION_META_PATH = path.join(__dirname, '.session-meta.json');

function saveSessionMeta() {
  const meta = {};
  for (const [id, s] of sessions) {
    meta[`cm-${id}`] = { name: s.name, dir: s.dir };
  }
  try { fs.writeFileSync(SESSION_META_PATH, JSON.stringify(meta, null, 2)); } catch {}
}

function loadSessionMeta() {
  try { return JSON.parse(fs.readFileSync(SESSION_META_PATH, 'utf8')); }
  catch { return {}; }
}

function stripAnsi(str) {
  return str
    // OSC sequences (both BEL and ST terminated)
    .replace(/\x1b\].*?(?:\x07|\x1b\\)/gs, '')
    // CSI sequences (includes ? for DEC private modes like bracketed paste)
    .replace(/\x1b\[[\x20-\x3f]*[0-9;]*[\x20-\x3f]*[A-Za-z]/g, '')
    // DCS/PM/APC sequences (ST terminated)
    .replace(/\x1b[PX^_].*?(?:\x1b\\|\x07)/gs, '')
    // Two-char escape sequences (cursor save/restore, charset select, etc.)
    .replace(/\x1b[^[\]PX^_\x1b]/g, '')
    // Remaining control chars except \n and \t
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    // Collapse \r\n to \n and strip bare \r (line overwrites)
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
}

// Accumulate recent output for better attention detection
let recentOutput = new Map(); // session id -> last N chars of output

function updateRecentOutput(sessionId, data) {
  const existing = recentOutput.get(sessionId) || '';
  const combined = existing + data;
  // Keep last 4KB for pattern matching (Claude Code outputs are verbose)
  recentOutput.set(sessionId, combined.length > 4096 ? combined.slice(-4096) : combined);
}

// Attention rules: { pattern, target (last3/last5/lastLine/perLine), reason, lineCheck? }
const ATTENTION_RULES = [
  // Permission prompts -- Claude Code tool approval
  { pattern: /Allow|Deny|Don't allow|allow this|for this session|always allow/i, target: 'last5', reason: 'permission' },
  { pattern: /\(y\/n\)/i, target: 'last5', reason: 'permission' },
  // Question directed at user (near bottom, not a URL/comment)
  { pattern: /\?\s*$/, target: 'last3', reason: 'question', lineCheck: (lastLine) => !/^\s*(http|\/\/|#)/.test(lastLine) },
  // Claude Code idle prompt chars
  { pattern: /^[\s.]*[>\u276f\u2771\u279c][\s.]*$/, target: 'perLine5', reason: 'ready' },
  { pattern: /^[^a-zA-Z0-9]*[>$%#\u276f\u2771\u279c][^a-zA-Z0-9]*$/, target: 'perLine5', reason: 'ready', lineCheck: (line) => line.length < 10 },
  // Status bar pattern
  { pattern: /\d+%\s*(\d+ local)?/i, target: 'lastLine', reason: 'ready', lineCheck: (_ll, last3) => /[│\|]/.test(last3) },
  // Cost/token summary
  { pattern: /total cost|tokens used|input:|output:/i, target: 'last3', reason: 'ready' },
  { pattern: /\$[\d.]+\s*\|\s*[\d.]+[KMkm]?\s*(in|tokens)/i, target: 'last3', reason: 'ready' },
  // Completion markers
  { pattern: /(?:crunched|cogitated) for/i, target: 'last5', reason: 'ready' },
  { pattern: /task completed|changes (saved|committed|applied)|done[.!]?\s*$/i, target: 'last3', reason: 'ready' },
  // Shell prompt
  { pattern: /^[\s]*[$%#>][\s]*$/, target: 'lastLine', reason: 'ready' },
];

function detectAttention(sessionId) {
  const raw = recentOutput.get(sessionId) || '';
  const clean = stripAnsi(raw);
  const lines = clean.split('\n').map(l => l.trim()).filter(Boolean);
  const lastLine = lines[lines.length - 1] || '';
  const last3 = lines.slice(-3).join('\n');
  const last5 = lines.slice(-5).join('\n');

  for (const rule of ATTENTION_RULES) {
    if (rule.target === 'perLine5') {
      for (const line of lines.slice(-5)) {
        if (rule.pattern.test(line) && (!rule.lineCheck || rule.lineCheck(line, last3))) return rule.reason;
      }
    } else {
      const text = rule.target === 'lastLine' ? lastLine : rule.target === 'last3' ? last3 : last5;
      if (rule.pattern.test(text) && (!rule.lineCheck || rule.lineCheck(lastLine, last3))) return rule.reason;
    }
  }

  const preview = lines.slice(-3).map(l => l.substring(0, 80)).join(' | ');
  audit('ATTN-MISS', `session=${sessionId} lines=${lines.length} lastLine=[${lastLine.substring(0, 60)}] preview=[${preview}]`);
  return null;
}

function getSessionList() {
  return Array.from(sessions.values()).map(s => ({
    id: s.id, name: s.name, dir: s.dir, attention: s.attention,
    viewers: s.clients.size
  }));
}

function broadcastAll(obj) {
  for (const client of allClients) {
    if (client.authenticated && client.readyState === 1) secureSend(client, obj);
  }
}

function broadcastSessions() {
  broadcastAll({ type: 'sessions', sessions: getSessionList() });
}

function broadcastAttention(sessionId, reason) {
  broadcastAll({ type: 'attention', session: sessionId, reason });
}

// Auth success: send auth response + session list + timing config
function completeAuth(ws, token, extra) {
  secureSend(ws, { type: 'auth', success: true, sessionToken: token, ttl: SESSION_TTL_MS, inactivityMs: INACTIVITY_MS, ...extra });
  secureSend(ws, { type: 'sessions', sessions: getSessionList() });
}

// Wire up proc.onData and proc.onExit for a session (shared by create + recover)
function wireSessionProc(session) {
  const { id } = session;

  session.proc.onData((data) => {
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

    // Debounce: wait for output to settle, then check accumulated buffer.
    // 5s avoids false triggers during Claude's mid-response pauses.
    if (session.attentionTimer) clearTimeout(session.attentionTimer);
    session.attentionTimer = setTimeout(() => {
      const reason = detectAttention(id);
      if (reason) {
        session.attention = reason;
        broadcastAttention(id, reason);
        broadcastSessions();
        // Only clear buffer on successful detection
        recentOutput.delete(id);
      }
      // On miss: keep buffer so next check has more context
    }, 5000);
  });

  session.proc.onExit(() => {
    // PTY (wsl.exe) exited -- check if dtach session is still alive
    if (dtachSessionAlive(id)) {
      // dtach survived (e.g., server restart) -- reattach after short delay
      audit('SESSION', `PTY detached, dtach alive: ${dtachSocketName(id)}`);
      setTimeout(() => {
        if (!sessions.has(id)) return; // cleaned up already
        try {
          session.proc = attachToDtach(id, 80, 24);
          wireSessionProc(session);
          audit('SESSION', `Reattached to dtach: ${dtachSocketName(id)}`);
        } catch (e) {
          audit('ERROR', `Reattach failed: ${e.message}`);
          sessions.delete(id);
          recentOutput.delete(id);
          broadcastSessions();
        }
      }, 1000);
    } else {
      // dtach session is gone -- clean up
      if (session.attentionTimer) clearTimeout(session.attentionTimer);
      recentOutput.delete(id);
      sessions.delete(id);
      broadcastSessions();
    }
  });
}

function createSession(name, dir, cols, rows) {
  if (sessions.size >= MAX_SESSIONS) return null;
  const id = nextId++;
  const wslDir = winPathToWsl(dir);

  try {
    createDtachSession(id, wslDir, cols, rows);
  } catch (e) {
    audit('ERROR', `dtach create failed: ${e.message}`);
    return null;
  }

  // Brief delay to let dtach socket appear before attaching
  try { execSync('timeout /t 1 /nobreak >nul 2>&1', { timeout: 3000 }); } catch {}

  const proc = attachToDtach(id, cols || 50, rows || 30);

  const session = {
    id, name, dir, proc, scrollback: '',
    attention: null, attentionTimer: null, clients: new Set()
  };

  wireSessionProc(session);
  sessions.set(id, session);
  audit('SESSION', `Created: "${name}" in ${dir} (dtach: ${dtachSocketName(id)})`);
  saveSessionMeta();
  return session;
}

// Recover existing dtach sessions after server restart
function recoverDtachSessions() {
  const existing = listDtachSessions();
  if (existing.length === 0) return;

  console.log(`  Recovering ${existing.length} dtach session(s)...`);
  const meta = loadSessionMeta();
  for (const idNum of existing) {
    // Restore name and dir from saved metadata, fall back to generic
    const metaKey = `cm-${idNum}`;
    const saved = meta[metaKey];
    const name = saved?.name || `Recovered-${idNum}`;
    const dir = saved?.dir || 'unknown';

    try {
      const proc = attachToDtach(idNum, 80, 24);

      const session = {
        id: idNum, name, dir, proc,
        scrollback: '', // rebuilds from live output
        attention: null, attentionTimer: null, clients: new Set()
      };

      wireSessionProc(session);
      sessions.set(idNum, session);
      if (idNum >= nextId) nextId = idNum + 1;
      console.log(`  Recovered: "${name}" (${metaKey})`);
    } catch (e) {
      audit('ERROR', `Recovery failed for ${metaKey}: ${e.message}`);
    }
  }
  // Persist metadata immediately so renames from this session are captured
  if (sessions.size > 0) saveSessionMeta();
}

// ─── WebSocket ───────────────────────────────────────────────────
const allClients = new Set();
const MAX_CONNECTIONS_PER_IP = 10;

function getClientIP(ws) {
  // tailscale serve proxies from localhost -- trust X-Forwarded-For from loopback only
  const peerIP = ws._socket?._peername?.address || ws._req?.socket?.remoteAddress || 'unknown';
  const isLoopback = peerIP === '127.0.0.1' || peerIP === '::1' || peerIP === '::ffff:127.0.0.1';
  if (isLoopback) {
    const xff = ws._req?.headers?.['x-forwarded-for'];
    if (xff) return xff.split(',')[0].trim();
  }
  return peerIP;
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
  ws.locked = false;
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
        // Check inactivity on reconnect -- send lock before accepting commands
        const locked = isTokenInactive(msg.sessionToken);
        if (locked) {
          ws.locked = true;
          audit('AUTH', `Reconnect locked (inactive)`, ws._ip);
        }
        completeAuth(ws, msg.sessionToken, { locked, ...authState });
        if (locked) secureSend(ws, { type: 'lock' });
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
        completeAuth(ws, st, authState);
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
        completeAuth(ws, msg.sessionToken, { hasPasskey: true });
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

    // ── Unlock (re-auth from lock screen) ──
    if (msg.type === 'unlock') {
      if (!ws.locked) return;
      // Passkey unlock: validate session token from passkey auth flow
      if (msg.sessionToken && validateSessionToken(msg.sessionToken, ws._ip)) {
        ws.locked = false;
        ws._sessionToken = msg.sessionToken;
        touchTokenActivity(msg.sessionToken);
        lastAuthenticatedActivity = Date.now();
        secureSend(ws, { type: 'unlocked' });
        audit('AUTH', `Unlocked via passkey`, ws._ip);
        return;
      }
      // TOTP unlock
      if (msg.totp && verifyTotp(msg.totp)) {
        ws.locked = false;
        touchTokenActivity(ws._sessionToken);
        lastAuthenticatedActivity = Date.now();
        secureSend(ws, { type: 'unlocked' });
        audit('AUTH', `Unlocked via TOTP`, ws._ip);
        return;
      }
      recordIPFailure(ws._ip);
      secureSend(ws, { type: 'error', message: 'Unlock failed' });
      return;
    }

    // Check session token still valid
    if (ws._sessionToken && !validateSessionToken(ws._sessionToken, ws._ip)) {
      ws.authenticated = false;
      secureSend(ws, { type: 'expired' });
      audit('AUTH', `Session expired`, ws._ip);
      return;
    }

    // Inactivity lock: check if token is inactive, enforce lock
    if (ws._sessionToken && isTokenInactive(ws._sessionToken)) {
      ws.locked = true;
      secureSend(ws, { type: 'lock' });
      audit('AUTH', `Inactivity lock triggered`, ws._ip);
      return;
    }
    if (ws.locked) {
      secureSend(ws, { type: 'error', message: 'Locked -- re-authenticate to continue' });
      return;
    }

    // Update activity trackers
    lastAuthenticatedActivity = Date.now();
    touchTokenActivity(ws._sessionToken);

    // Pre-resolve session for commands that operate on it
    const activeSession = ws.currentSession !== null ? sessions.get(ws.currentSession) : null;
    const targetSession = msg.session != null ? sessions.get(msg.session) : null;

    switch (msg.type) {
      case 'create': {
        const dir = msg.dir || config.projects[0].dir;
        const allowedDirs = config.projects.map(p => p.dir);
        if (!allowedDirs.includes(dir)) {
          secureSend(ws, { type: 'error', message: 'Directory not in allowed project list' });
          break;
        }
        const created = createSession(msg.name || 'Session', dir, msg.cols, msg.rows);
        if (created) {
          broadcastSessions();
          secureSend(ws, { type: 'created', session: created.id });
        } else {
          secureSend(ws, { type: 'error', message: `Max sessions reached (${MAX_SESSIONS})` });
        }
        break;
      }

      case 'connect': {
        if (!targetSession) break;
        if (ws.currentSession !== null) {
          sessions.get(ws.currentSession)?.clients.delete(ws);
        }
        ws.currentSession = msg.session;
        targetSession.clients.add(ws);
        // Send server-side scrollback buffer on reconnect.
        // Client uses chunked writes with term.reset() to replay cleanly.
        if (targetSession.scrollback) {
          audit('SCROLLBACK', `sending ${targetSession.scrollback.length} bytes from buffer`);
          secureSend(ws, { type: 'scrollback', session: targetSession.id, data: targetSession.scrollback });
        }
        if (targetSession.attention) {
          secureSend(ws, { type: 'attention', session: targetSession.id, reason: targetSession.attention });
        }
        // Send available commands for this session's project
        sendCommandsToClient(ws, targetSession.dir);
        break;
      }

      case 'input': {
        if (!activeSession) break;
        if (typeof msg.data !== 'string' || msg.data.length > 65536) {
          secureSend(ws, { type: 'warning', message: 'Input too large (64KB max)' });
          break;
        }
        const canary = checkCanary(msg.data);
        if (canary) {
          audit('CANARY', `Suspicious input detected: ${canary}`, ws._ip);
          secureSend(ws, { type: 'warning', message: `Canary triggered: ${canary}` });
        }
        const inputHash = crypto.createHash('sha256').update(msg.data).digest('hex').slice(0, 12);
        audit('INPUT', `session=${ws.currentSession} len=${msg.data.length} hash=${inputHash}`, ws._ip);
        try { activeSession.proc.write(msg.data); } catch (e) {
          audit('ERROR', `pty write: ${e.message}`);
        }
        if (activeSession.attention) { activeSession.attention = null; broadcastSessions(); }
        break;
      }

      case 'resize': {
        if (!activeSession || !msg.cols || !msg.rows) break;
        const cols = Math.max(40, Math.min(300, msg.cols));
        const rows = Math.max(10, Math.min(200, msg.rows));
        try {
          activeSession.proc.resize(cols, rows);
        } catch {}
        break;
      }

      case 'client-log': {
        audit('CLIENT', msg.message, ws._ip);
        break;
      }

      case 'rename': {
        if (!targetSession || !msg.name) break;
        const name = String(msg.name).slice(0, 50).replace(/[<>"'&]/g, '');
        targetSession.name = name;
        broadcastSessions();
        saveSessionMeta();
        break;
      }

      case 'close': {
        if (!targetSession) break;
        // Kill dtach session first (destroys the running process)
        killDtachSession(msg.session);
        try { targetSession.proc.kill(); } catch {}
        if (targetSession.attentionTimer) clearTimeout(targetSession.attentionTimer);
        recentOutput.delete(msg.session);
        sessions.delete(msg.session);
        if (ws.currentSession === msg.session) ws.currentSession = null;
        broadcastSessions();
        audit('SESSION', `Closed: "${targetSession.name}" (dtach: ${dtachSocketName(msg.session)})`, ws._ip);
        saveSessionMeta();
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

// ─── Housekeeping (single 60s timer) ─────────────────────────────
setInterval(() => {
  const now = Date.now();
  // Expired session tokens
  for (const [token, entry] of sessionTokens) {
    if (now > entry.expires) sessionTokens.delete(token);
  }
  // Expired WebAuthn challenges
  for (const [id, entry] of challenges) {
    if (now > entry.expires) challenges.delete(id);
  }
  // Stale IP rate limit entries
  for (const [ip, entry] of authAttempts) {
    if (entry.lockUntil && now > entry.lockUntil + 60000) authAttempts.delete(ip);
  }
  // Per-client: expiry + inactivity lock
  for (const ws of allClients) {
    if (!ws.authenticated || !ws._sessionToken) continue;
    if (!validateSessionToken(ws._sessionToken, ws._ip)) {
      ws.authenticated = false;
      secureSend(ws, { type: 'expired' });
      audit('AUTH', `Session auto-expired`, ws._ip);
      continue;
    }
    if (!ws.locked && isTokenInactive(ws._sessionToken)) {
      ws.locked = true;
      secureSend(ws, { type: 'lock' });
      audit('AUTH', `Inactivity lock (periodic)`, ws._ip);
    }
  }
}, 60 * 1000);

// ─── Skill & Command Discovery ───────────────────────────────────
// Mirrors Claude Code's discovery: skills/ (SKILL.md dirs) + commands/ (.md files).
// Subdirectories in commands/ become namespaced: commands/gsd/add-phase.md -> /gsd:add-phase
const BUILTIN_COMMANDS = [
  { cmd: '/help', desc: 'Show help and commands' },
  { cmd: '/clear', desc: 'Clear conversation context' },
  { cmd: '/compact', desc: 'Compact context to save space' },
  { cmd: '/config', desc: 'View/modify configuration' },
  { cmd: '/context', desc: 'View context window usage' },
  { cmd: '/cost', desc: 'Show token usage and cost' },
  { cmd: '/doctor', desc: 'Check Claude Code health' },
  { cmd: '/fast', desc: 'Toggle fast mode (same model, faster output)' },
  { cmd: '/init', desc: 'Initialize CLAUDE.md in project' },
  { cmd: '/login', desc: 'Switch Anthropic account' },
  { cmd: '/logout', desc: 'Sign out of Anthropic' },
  { cmd: '/memory', desc: 'Edit CLAUDE.md project memory' },
  { cmd: '/model', desc: 'Switch AI model' },
  { cmd: '/permissions', desc: 'View/manage tool permissions' },
  { cmd: '/pr-comments', desc: 'View PR review comments' },
  { cmd: '/review', desc: 'Review a pull request' },
  { cmd: '/skills', desc: 'List all available skills' },
  { cmd: '/status', desc: 'Show account and session status' },
  { cmd: '/terminal-setup', desc: 'Install shell integration' },
  { cmd: '/vim', desc: 'Toggle vim keybindings' },
];

// Extract description from YAML frontmatter (single-line or multi-line)
function extractDescription(content) {
  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!fmMatch) return '';
  const fm = fmMatch[1];
  // Multi-line YAML description (description: >- or description: >)
  const multiMatch = fm.match(/description:\s*>-?\s*\n([\s\S]*?)(?=\n\w|\n---)/);
  if (multiMatch) {
    return multiMatch[1].split('\n').map(l => l.trim()).filter(Boolean)[0] || '';
  }
  // Single-line description
  const singleMatch = fm.match(/description:\s*['"]?(.+?)['"]?\s*$/m);
  return singleMatch ? singleMatch[1] : '';
}

// Scan skills/ directory: each subdirectory with SKILL.md becomes a skill
function scanSkillDir(dir) {
  const skills = [];
  if (!fs.existsSync(dir)) return skills;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return skills; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillFile = path.join(dir, entry.name, 'SKILL.md');
    if (!fs.existsSync(skillFile)) continue;
    try {
      const content = fs.readFileSync(skillFile, 'utf8');
      // Skip only if explicitly marked non-invocable (Claude Code defaults to invocable)
      if (/user-invocable:\s*false/i.test(content)) continue;
      let desc = extractDescription(content);
      if (desc.length > 80) desc = desc.slice(0, 77) + '...';
      skills.push({ cmd: '/' + entry.name, desc });
    } catch {}
  }
  return skills;
}

// Scan commands/ directory: .md files become commands, subdirectories become namespaces.
// commands/foo.md -> /foo
// commands/gsd/add-phase.md -> /gsd:add-phase
function scanCommandDir(dir) {
  const commands = [];
  if (!fs.existsSync(dir)) return commands;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return commands; }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      // Namespace: subdir/*.md -> /subdir:name
      const subdir = path.join(dir, entry.name);
      let subEntries;
      try { subEntries = fs.readdirSync(subdir, { withFileTypes: true }); } catch { continue; }
      for (const sub of subEntries) {
        if (!sub.isFile() || !sub.name.endsWith('.md')) continue;
        try {
          const content = fs.readFileSync(path.join(subdir, sub.name), 'utf8');
          const cmdName = sub.name.replace(/\.md$/, '');
          // Use name from frontmatter if present, otherwise derive from path
          const nameMatch = content.match(/^---\s*\n[\s\S]*?name:\s*['"]?(.+?)['"]?\s*$/m);
          const cmd = nameMatch ? '/' + nameMatch[1] : '/' + entry.name + ':' + cmdName;
          let desc = extractDescription(content);
          if (desc.length > 80) desc = desc.slice(0, 77) + '...';
          commands.push({ cmd, desc });
        } catch {}
      }
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      // Top-level: foo.md -> /foo
      try {
        const content = fs.readFileSync(path.join(dir, entry.name), 'utf8');
        const cmdName = entry.name.replace(/\.md$/, '');
        const nameMatch = content.match(/^---\s*\n[\s\S]*?name:\s*['"]?(.+?)['"]?\s*$/m);
        const cmd = nameMatch ? '/' + nameMatch[1] : '/' + cmdName;
        let desc = extractDescription(content);
        if (desc.length > 80) desc = desc.slice(0, 77) + '...';
        commands.push({ cmd, desc });
      } catch {}
    }
  }
  return commands;
}

function scanAllForProject(projectDir) {
  const projectSkills = scanSkillDir(path.join(projectDir, '.claude', 'skills'));
  const globalSkills = scanSkillDir(path.join(os.homedir(), '.claude', 'skills'));
  const projectCommands = scanCommandDir(path.join(projectDir, '.claude', 'commands'));
  const globalCommands = scanCommandDir(path.join(os.homedir(), '.claude', 'commands'));
  // Project overrides global (by command name)
  const seen = new Set([...projectSkills, ...projectCommands].map(s => s.cmd));
  const merged = [
    ...projectSkills,
    ...projectCommands,
    ...globalSkills.filter(s => !seen.has(s.cmd)),
    ...globalCommands.filter(s => !seen.has(s.cmd)),
  ];
  merged.sort((a, b) => a.cmd.localeCompare(b.cmd));
  return [...BUILTIN_COMMANDS, ...merged];
}

// Cache per project dir, invalidated by watchers
const commandsCache = new Map(); // projectDir -> { commands, watchers }

function getCommandsForProject(projectDir) {
  if (commandsCache.has(projectDir)) return commandsCache.get(projectDir).commands;
  const commands = scanAllForProject(projectDir);
  commandsCache.set(projectDir, { commands, watchers: [] });
  return commands;
}

function watchSkillDirs(projectDir) {
  const entry = commandsCache.get(projectDir);
  if (!entry || entry.watchers.length > 0) return; // already watching
  const dirs = [
    path.join(projectDir, '.claude', 'skills'),
    path.join(projectDir, '.claude', 'commands'),
    path.join(os.homedir(), '.claude', 'skills'),
    path.join(os.homedir(), '.claude', 'commands'),
  ];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    try {
      const watcher = fs.watch(dir, { recursive: true }, () => {
        // Debounce: skills change in bursts (plugin install)
        if (entry._debounce) clearTimeout(entry._debounce);
        entry._debounce = setTimeout(() => {
          const newCommands = scanAllForProject(projectDir);
          entry.commands = newCommands;
          audit('SKILLS', `Rescanned ${newCommands.length} commands for ${path.basename(projectDir)}`);
          // Push to all authenticated clients viewing a session in this project
          for (const client of allClients) {
            if (!client.authenticated || client.readyState !== 1) continue;
            if (client.currentSession === null) continue;
            const sess = sessions.get(client.currentSession);
            if (sess && sess.dir === projectDir) {
              secureSend(client, { type: 'commands', commands: newCommands });
            }
          }
        }, 1000);
      });
      entry.watchers.push(watcher);
    } catch {}
  }
}

function sendCommandsToClient(ws, projectDir) {
  const commands = getCommandsForProject(projectDir);
  secureSend(ws, { type: 'commands', commands });
  watchSkillDirs(projectDir);
}

// ─── Startup ─────────────────────────────────────────────────────
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

// ─── Tailscale configuration ─────────────────────────────────────
// Server binds localhost only. Tailscale serve proxies HTTPS -> localhost.
const TAILSCALE_HOSTNAME = config.tailscaleHostname;
if (TAILSCALE_HOSTNAME) {
  rpID = TAILSCALE_HOSTNAME;
  expectedOrigin = `https://${TAILSCALE_HOSTNAME}`;
}

function detectTailscale() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && net.address.startsWith('100.')) {
        return net.address;
      }
    }
  }
  return null;
}

server.listen(PORT, 'localhost', () => {
  const tsIP = detectTailscale();
  console.log('');
  console.log('  Claude Mobile Bridge (zero-trust)');
  console.log('  ────────────────────────────────');
  console.log(`  Local:    http://localhost:${PORT}`);
  if (TAILSCALE_HOSTNAME) {
    console.log(`  Tailscale: https://${TAILSCALE_HOSTNAME}`);
  }
  if (tsIP) {
    console.log(`  Network:  Tailscale active (${tsIP})`);
  } else {
    console.log('  WARNING:  Tailscale not detected -- localhost only');
  }
  if (isSetupComplete()) {
    console.log(`  Auth:     TOTP configured, passkeys: ${storedCredentials.length}`);
    if (TAILSCALE_HOSTNAME && storedCredentials.length === 0) {
      console.log(`  NOTICE:   Passkeys must be re-registered for new domain`);
      console.log(`            Visit http://localhost:${PORT}/setup`);
    }
  } else {
    console.log(`  Auth:     NOT CONFIGURED`);
    console.log(`  Setup:    http://localhost:${PORT}/setup`);
  }
  console.log(`  Identity: ${identityKeys.fingerprint.slice(0, 16)}...`);
  console.log(`  Audit:    ${AUDIT_PATH}`);
  console.log(`  Shutdown: auto after 8h idle`);
  console.log(`  Sessions: dtach via WSL (${WSL_DISTRO})`);
  console.log('  ────────────────────────────────');
  recoverDtachSessions();
  if (sessions.size === 0) autoStartSessions();
  audit('SYSTEM', `Server started on port ${PORT}`);
});
