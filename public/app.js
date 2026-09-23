let ws = null, sessionList = [], activeSession = null;
let terms = {}, fits = {}, projects = [];

// T19 of W5 (render-pipeline): grid renderer state, parallel to terms{}.
// One entry per session when RENDERER_MODE === 'grid'.
let gridTerms = {};

// W6 T24: default flipped to the cell-grid renderer (3.2.18). The legacy
// xterm.js path remains available via ?renderer=xterm as a fallback for any
// issue grid mode hasn't yet covered. T26-T28 (delete the legacy WS
// scrollback handler, drop the xterm.js vendor bundle, sweep CLAUDE.md)
// are intentionally held -- the fallback stays shipped indefinitely. The
// flag goes out in every 'connect' message so the server's per-WS
// gridRenderer flag tracks it.
const RENDERER_MODE = (new URLSearchParams(location.search).get('renderer') === 'xterm') ? 'xterm' : 'grid';
let reconnectDelay = 1000;
let reconnectTimer = null;
let sessionToken = null;
let refreshTimer = null;

let decryptFailCount = 0;
let decryptReconnectCount = 0;

// ── Client Diagnostic Logging (sent back to server via WS) ──
function clientLog(msg) {
  console.log(msg);
  if (ws && ws.readyState === 1 && e2eReady) {
    try { queueSend({ type: 'client-log', message: String(msg).slice(0, 500) }); } catch {}
  }
}

// ── E2E Encryption State ──
let e2eKey = null; // CryptoKey for AES-256-GCM
let e2eSendSeq = 0, e2eRecvSeq = 0;
let e2eReady = false;
// W4/C1 -- IV domain separation. One key is shared in both directions, so the
// first IV byte marks who sent the frame. These MUST match server.js.
const IV_DIR_SERVER = 1;   // server -> client
const IV_DIR_CLIENT = 0;   // client -> server
let pendingAuth = null; // { method, totpCode } -- deferred until E2E ready
let sendQueue = Promise.resolve();

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
  return bytes;
}

function bytesToHex(bytes) {
  return Array.from(new Uint8Array(bytes)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function base64urlEncode(buf) {
  const bytes = new Uint8Array(buf instanceof ArrayBuffer ? buf : buf.buffer || buf);
  let str = '';
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function base64urlDecode(s) {
  const str = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  const binary = atob(str + pad);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function handleKeyExchange(msg) {
  showStatus('Key exchange...', 'var(--accent-text)');
  try {
    // Import server identity pubkey for signature verification
    showStatus('Importing identity key...', 'var(--accent-text)');
    const identityDer = hexToBytes(msg.identity);
    const identityKey = await crypto.subtle.importKey('spki', identityDer,
      { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);

    // Verify ECDSA signature on ephemeral pubkey
    showStatus('Verifying signature...', 'var(--accent-text)');
    const ephBytes = hexToBytes(msg.ephemeral);
    const sigBytes = hexToBytes(msg.sig);
    const valid = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' }, identityKey, sigBytes, ephBytes);
    if (!valid) {
      showStatus('SIGNATURE INVALID', 'var(--intent-danger-text)');
      ws.close(); return;
    }

    // TOFU fingerprint check
    const fpBuf = await crypto.subtle.digest('SHA-256', identityDer);
    const fingerprint = bytesToHex(fpBuf);
    const storedFP = localStorage.getItem('cm-server-fp');

    if (!storedFP) {
      // First connection -- show confirmation
      const shortFP = fingerprint.slice(0, 8) + ' ' + fingerprint.slice(8, 16) +
                       ' ' + fingerprint.slice(16, 24) + ' ' + fingerprint.slice(24, 32);
      if (!confirm('First secure connection.\n\nServer fingerprint:\n' + shortFP +
                    '\n\nVerify this matches your laptop /setup page.\nPin this server?')) {
        ws.close(); return;
      }
      localStorage.setItem('cm-server-fp', fingerprint);
    } else if (storedFP !== fingerprint) {
      // Key changed -- warning
      const oldShort = storedFP.slice(0, 16);
      const newShort = fingerprint.slice(0, 16);
      if (!confirm('WARNING: SERVER KEY CHANGED\n\nOld: ' + oldShort + '...\nNew: ' + newShort +
                    '...\n\nThis could indicate a man-in-the-middle attack.\nRe-pin new key?')) {
        ws.close(); return;
      }
      localStorage.setItem('cm-server-fp', fingerprint);
    }

    // Generate client ephemeral ECDH keypair
    showStatus('Generating keys...', 'var(--accent-text)');
    const clientKP = await crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);

    // Import server ephemeral pubkey (raw uncompressed EC point)
    const serverEphKey = await crypto.subtle.importKey('raw', ephBytes,
      { name: 'ECDH', namedCurve: 'P-256' }, false, []);

    // Derive shared secret
    showStatus('Deriving secret...', 'var(--accent-text)');
    const sharedBits = await crypto.subtle.deriveBits(
      { name: 'ECDH', public: serverEphKey }, clientKP.privateKey, 256);

    // Export client public key as raw
    const clientPubRaw = await crypto.subtle.exportKey('raw', clientKP.publicKey);
    const clientPubHex = bytesToHex(clientPubRaw);

    // HKDF: derive AES key
    showStatus('Deriving session key...', 'var(--accent-text)');
    const salt = hexToBytes(msg.salt);
    const info = new Uint8Array([
      ...new TextEncoder().encode('cm-e2e'),
      ...new Uint8Array(clientPubRaw),
      ...ephBytes,
    ]);
    const hkdfKey = await crypto.subtle.importKey('raw', sharedBits, 'HKDF', false, ['deriveBits']);
    const derivedBits = await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt, info }, hkdfKey, 256);
    e2eKey = await crypto.subtle.importKey('raw', derivedBits,
      { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);

    e2eSendSeq = 0;
    e2eRecvSeq = 0;
    e2eReady = true;

    // Send client ephemeral pubkey (plaintext -- last unencrypted message)
    ws.send(JSON.stringify({ type: 'key-exchange', ephemeral: clientPubHex }));
    showStatus('Secure channel established', 'var(--intent-ok-text)');
  } catch (err) {
    console.error('Key exchange error:', err);
    showStatus('Key exchange failed: ' + err.message, 'var(--intent-danger-text)');
    ws.close();
  }
}

async function secureSend(obj) {
  if (!e2eReady || !e2eKey) {
    if (e2eSendSeq > 0) {
      clientLog('DROPPED: plaintext send blocked after E2E was active (type: ' + obj.type + ')');
      return;
    }
    ws.send(JSON.stringify(obj));
    return;
  }
  e2eSendSeq++;
  // W4/C1 -- IV = direction byte, 3 zero bytes, 8-byte BE counter.
  // Both endpoints derive the SAME key and both counters start at 1, so
  // without the direction byte the server's frame #1 and the client's frame #1
  // shared an (key, IV) pair -- a catastrophic GCM nonce reuse. The server's
  // first frame is a fixed known plaintext and this one is the TOTP, so XORing
  // the two ciphertexts recovered the code in cleartext. MUST match server.js.
  const iv = new Uint8Array(12);
  iv[0] = IV_DIR_CLIENT;
  const dv = new DataView(iv.buffer);
  dv.setBigUint64(4, BigInt(e2eSendSeq));
  const seqBuf = new Uint8Array(8);
  new DataView(seqBuf.buffer).setBigUint64(0, BigInt(e2eSendSeq));
  const plaintext = new TextEncoder().encode(JSON.stringify(obj));
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: seqBuf }, e2eKey, plaintext);
  // AES-GCM output = ciphertext + tag (last 16 bytes) appended by Web Crypto
  const combined = new Uint8Array(12 + encrypted.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(encrypted), 12);
  ws.send(JSON.stringify({ e: base64urlEncode(combined), n: e2eSendSeq }));
}

function queueSend(obj) {
  sendQueue = sendQueue.then(() => secureSend(obj)).catch(e => clientLog('queueSend error: ' + e.message));
}

async function secureReceive(rawData) {
  let parsed;
  try { parsed = JSON.parse(rawData); } catch { clientLog('JSON parse failed'); return null; }
  // W4/C2 + C3 -- these two short-circuits used to sit ABOVE the
  // anti-downgrade guard at the bottom of this function, which made both
  // exploitable:
  //   C2: an injected plaintext {"type":"encrypted"} fired the deferred
  //       pendingAuth while e2eReady was still false, and secureSend's
  //       pre-E2E branch then transmitted the TOTP in CLEARTEXT.
  //   C3: a plaintext key-exchange accepted mid-session reset e2eKey and both
  //       counters, letting an attacker re-handshake behind one confirm() tap.
  // Once a handshake has begun, neither is legitimate. The server already
  // refuses post-handshake rekey; the client now matches it.
  if (parsed.type === 'key-exchange') {
    if (e2eReady || e2eSendSeq > 0) {
      clientLog('SECURITY: key-exchange after handshake rejected');
      return null;
    }
    return parsed;
  }
  if (parsed.type === 'encrypted') {
    if (e2eReady) return parsed;          // the genuine ack, during handshake
    if (!e2eKey) {
      clientLog('SECURITY: plaintext "encrypted" ack before key derivation rejected');
      return null;
    }
    return parsed;
  }
  if (parsed.e) {
    if (!e2eReady || !e2eKey) return null;
    if (parsed.n <= e2eRecvSeq) {
      clientLog('Replay rejected: seq ' + parsed.n + ' <= ' + e2eRecvSeq);
      return null;
    }
    if (parsed.n > e2eRecvSeq + 1) {
      clientLog('Seq gap detected: expected ' + (e2eRecvSeq + 1) + ' got ' + parsed.n);
    }
    try {
      const data = base64urlDecode(parsed.e);
      const iv = data.subarray(0, 12);
      // W4/C1 -- the peer must use the SERVER direction. Rejecting our own
      // direction byte blocks reflection of a client frame back at us.
      if (iv[0] !== IV_DIR_SERVER) {
        clientLog('SECURITY: IV direction byte wrong, expected ' + IV_DIR_SERVER + ' got ' + iv[0]);
        return null;
      }
      const ciphertext = data.subarray(12); // includes tag (Web Crypto handles it)
      const seqBuf = new Uint8Array(8);
      new DataView(seqBuf.buffer).setBigUint64(0, BigInt(parsed.n));
      const decrypted = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv, additionalData: seqBuf }, e2eKey, ciphertext);
      e2eRecvSeq = parsed.n;
      decryptFailCount = 0;
      return JSON.parse(new TextDecoder().decode(decrypted));
    } catch (err) {
      clientLog('DECRYPT FAILED: ' + err.message + ' payload:' + (parsed.e?.length || '?') + 'bytes seq:' + parsed.n);
      decryptFailCount++;
      if (decryptFailCount === 1) showStatus('Decrypt error -- retrying...', 'var(--intent-warn-text)');
      if (decryptFailCount >= 3) {
        decryptReconnectCount++;
        if (decryptReconnectCount <= 3) {
          showStatus('Encryption error -- reconnecting...', 'var(--intent-danger-text)');
          setTimeout(() => doConnect('reconnect'), 500);
        } else {
          showStatus('Persistent encryption error. Reload the page.', 'var(--intent-danger-text)');
        }
      }
      return null;
    }
  }
  // Plaintext after encryption = anti-downgrade violation
  if (e2eReady) return null;
  return parsed;
}

// Silent token rotation: refresh at 75% of TTL so the token
// is always fresh. Old token invalidated immediately on rotation.
function scheduleTokenRefresh(ttl) {
  if (refreshTimer) clearTimeout(refreshTimer);
  const interval = (ttl || 30 * 60 * 1000) * 0.75; // 75% of TTL
  refreshTimer = setTimeout(() => {
    if (ws && ws.readyState === 1 && sessionToken) {
      queueSend({ type: 'refresh' });
    }
  }, interval);
}

const $ = id => document.getElementById(id);
const authScreen = $('auth-screen');
const authError = $('auth-error'), authStatus = $('auth-status');
const appEl = $('app'), termArea = $('term-area'), emptyState = $('empty-state');
const dot = $('dot'), sname = $('sname'), sdir = $('sdir');
const msgInput = $('msg'), tabsEl = $('tabs');

// ─── Auth Screen Mode Management ────────────────────────────────
function setAuthMode(mode) {
  authScreen.dataset.mode = mode;
  const heading = $('auth-heading');
  const lockIcon = $('auth-lock-icon');
  const submitBtn = $('auth-submit-btn');
  if (mode === 'lock') {
    heading.textContent = 'SESSION LOCKED';
    lockIcon.style.display = '';
    $('auth-label').textContent = 'Inactive timeout -- re-authenticate to continue';
    submitBtn.textContent = 'Unlock';
    $('setup-msg').style.display = 'none';
  } else {
    heading.textContent = 'CLAUDE MOBILE';
    lockIcon.style.display = 'none';
    $('auth-label').textContent = 'Authenticate to connect';
    submitBtn.textContent = 'Verify';
  }
}

// ─── Inactivity Lock ─────────────────────────────────────────────
let inactivityTimer = null;
let inactivityMs = 15 * 60 * 1000; // default; overridden by server on auth

function resetInactivityTimer() {
  if (inactivityTimer) clearTimeout(inactivityTimer);
  inactivityTimer = setTimeout(() => {
    if (sessionToken) showLockScreen();
  }, inactivityMs);
}

function showLockScreen() {
  setAuthMode('lock');
  authScreen.classList.add('active');
  authError.style.display = 'none';
  $('totp-input').value = '';
  if (window.PublicKeyCredential) {
    $('passkey-btn').style.display = 'block';
  }
  $('totp-section').style.display = 'block';
}

function hideLockScreen() {
  authScreen.classList.remove('active');
  $('totp-input').value = '';
  authError.style.display = 'none';
  resetInactivityTimer();
}

// Unified action dispatcher for auth screen
function authAction(method) {
  if (authScreen.dataset.mode === 'lock') {
    if (method === 'passkey') unlockPasskey();
    else submitUnlockTotp();
  } else {
    if (method === 'passkey') loginPasskey();
    else submitTotp();
  }
}

async function unlockPasskey() {
  try {
    const token = await doPasskeyAuth();
    if (token) {
      queueSend({ type: 'unlock', sessionToken: token });
    } else {
      authError.textContent = 'Passkey verification failed';
      authError.style.display = 'block';
    }
  } catch (e) {
    authError.textContent = 'Passkey error -- use TOTP code';
    authError.style.display = 'block';
  }
}

function submitUnlockTotp() {
  const code = $('totp-input').value.trim();
  if (!code || code.length !== 6) return;
  authError.style.display = 'none';
  queueSend({ type: 'unlock', totp: code });
}

$('totp-input')?.addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); authAction('totp'); }
});

// T04a: the two auth buttons carried onclick="authAction(...)" in the markup.
// Bound here instead so script-src can drop 'unsafe-inline' (T04) -- CSP
// blocks inline handler attributes, not just inline <script> blocks.
$('passkey-btn').addEventListener('click', () => authAction('passkey'));
$('auth-submit-btn').addEventListener('click', () => authAction('totp'));

['touchstart', 'keydown', 'mousemove', 'click'].forEach(evt => {
  document.addEventListener(evt, resetInactivityTimer, { passive: true });
});

function showStatus(t, c) {
  authStatus.textContent = t;
  authStatus.style.color = c || 'var(--dim)';
  authStatus.style.display = 'block';
}

function submitTotp() {
  const code = $('totp-input').value.trim();
  if (!code || code.length !== 6) return;
  authError.style.display = 'none';
  showStatus('Verifying code...', 'var(--accent-text)');
  doConnect('totp', code);
}

async function checkAuthStatus() {
  try {
    const res = await fetch('/api/auth/status');
    const data = await res.json();
    if (data.setupDone) {
      if (data.hasPasskey) {
        $('passkey-btn').style.display = 'block';
        $('auth-label').textContent = 'Authenticate to connect';
      }
      if (data.hasTotp) {
        $('totp-section').style.display = 'block';
        if (!data.hasPasskey) $('auth-label').textContent = 'Enter verification code';
      }
      $('setup-msg').style.display = 'none';
    } else {
      $('setup-msg').style.display = 'block';
      $('passkey-btn').style.display = 'none';
      $('totp-section').style.display = 'none';
    }
  } catch (e) {
    // Fetch failed (proxy issue, network) -- show TOTP as fallback
    console.error('Auth status check failed:', e);
    $('totp-section').style.display = 'block';
    $('auth-label').textContent = 'Enter verification code';
  }
}

// Shared passkey auth: fetches options, prompts biometric, verifies, returns sessionToken or null
async function doPasskeyAuth() {
  const optRes = await fetch('/api/passkey/auth-options', { method: 'POST' });
  if (!optRes.ok) return null;
  const options = await optRes.json();
  options.challenge = base64urlDecode(options.challenge);
  if (options.allowCredentials) {
    options.allowCredentials = options.allowCredentials.map(c => ({
      ...c, id: base64urlDecode(c.id)
    }));
  }
  const credential = await navigator.credentials.get({ publicKey: options });
  const authRes = await fetch('/api/passkey/auth-verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      expectedChallenge: base64urlEncode(options.challenge),
      response: {
        id: credential.id,
        rawId: base64urlEncode(credential.rawId),
        response: {
          authenticatorData: base64urlEncode(credential.response.authenticatorData),
          clientDataJSON: base64urlEncode(credential.response.clientDataJSON),
          signature: base64urlEncode(credential.response.signature),
        },
        type: credential.type,
        clientExtensionResults: credential.getClientExtensionResults(),
        authenticatorAttachment: credential.authenticatorAttachment,
      }
    })
  });
  const result = await authRes.json();
  return (result.success && result.sessionToken) ? result.sessionToken : null;
}

async function loginPasskey() {
  showStatus('Requesting passkey...', 'var(--accent-text)');
  try {
    const token = await doPasskeyAuth();
    if (token) {
      sessionToken = token;
      showStatus('Authenticated via passkey', 'var(--intent-ok-text)');
      doConnect('passkey');
    } else {
      showStatus('Passkey verification failed', 'var(--intent-danger-text)');
    }
  } catch (e) {
    showStatus('Passkey error: ' + e.message, 'var(--intent-danger-text)');
  }
}

async function registerPasskey() {
  if (!sessionToken) return;
  try {
    const optRes = await fetch('/api/passkey/register-options', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionToken })
    });
    const options = await optRes.json();
    options.challenge = base64urlDecode(options.challenge);
    options.user.id = base64urlDecode(options.user.id);
    if (options.excludeCredentials) {
      options.excludeCredentials = options.excludeCredentials.map(c => ({
        ...c, id: base64urlDecode(c.id)
      }));
    }
    const credential = await navigator.credentials.create({ publicKey: options });
    const verRes = await fetch('/api/passkey/register-verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionToken,
        expectedChallenge: base64urlEncode(options.challenge),
        response: {
          id: credential.id,
          rawId: base64urlEncode(credential.rawId),
          response: {
            attestationObject: base64urlEncode(credential.response.attestationObject),
            clientDataJSON: base64urlEncode(credential.response.clientDataJSON),
          },
          type: credential.type,
          clientExtensionResults: credential.getClientExtensionResults(),
          authenticatorAttachment: credential.authenticatorAttachment,
        }
      })
    });
    const result = await verRes.json();
    if (result.verified) {
      alert('Passkey registered. Next time you can login with Face ID.');
      $('passkey-btn').style.display = 'block';
    }
  } catch (e) {
    showStatus('Passkey registration failed: ' + e.message, 'var(--intent-danger-text)');
  }
}

async function setupTotp() {
  if (!sessionToken) return;
  try {
    const res = await fetch('/api/totp/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionToken })
    });
    const data = await res.json();
    if (data.uri) {
      const secret = data.secret || data.uri.match(/secret=([^&]+)/)?.[1] || '';
      alert(
        'TOTP Setup\n\n' +
        '1. Open Settings > Passwords on your iPhone\n' +
        '2. Find or create an entry for "claude-mobile"\n' +
        '3. Tap "Set Up Verification Code"\n' +
        '4. Tap "Enter Setup Key" and paste this:\n\n' +
        secret + '\n\n' +
        'Then enter the 6-digit code to verify.'
      );
      try { await navigator.clipboard.writeText(secret); } catch (e) { console.warn('Clipboard unavailable:', e.message); }
      const verifyCode = async () => {
        const code = prompt('Enter the 6-digit code from Apple Passwords:');
        if (!code) return;
        const vRes = await fetch('/api/totp/verify-setup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionToken, code: code.trim() })
        });
        const vData = await vRes.json();
        if (vData.verified) {
          alert('TOTP verified. Backup authentication is ready.');
          checkAuthStatus();
        } else {
          if (confirm('Code incorrect. Try again?')) verifyCode();
        }
      };
      await verifyCode();
    }
  } catch (e) {
    showStatus('TOTP setup failed: ' + e.message, 'var(--intent-danger-text)');
  }
}

checkAuthStatus();

function doConnect(method, totpCode) {
  if (ws) try { ws.close(); } catch (e) { console.warn('ws.close:', e.message); }
  e2eReady = false; e2eKey = null; e2eSendSeq = 0; e2eRecvSeq = 0; decryptFailCount = 0;
  sendQueue = Promise.resolve();
  pendingAuth = { method, totpCode };
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}`);
  ws.onopen = () => {
    reconnectDelay = 1000; dot.className = 'dot on';
    showStatus('Connecting securely...', 'var(--accent-text)');
    // Wait for server key-exchange -- auth deferred until E2E ready
  };
  ws.onclose = () => {
    dot.className = 'dot off'; e2eReady = false;
    if (sessionToken) { showStatus('Reconnecting...', 'var(--intent-warn-text)'); clearTimeout(reconnectTimer); reconnectTimer = setTimeout(() => doConnect('reconnect'), reconnectDelay); }
    reconnectDelay = Math.min(reconnectDelay * 2, 30000);
  };
  ws.onerror = (ev) => {
    showStatus('Connection error', 'var(--intent-danger-text)');
  };
  ws.onmessage = async (e) => {
    // Safari may deliver WebSocket data as Blob instead of string
    const rawData = typeof e.data === 'string' ? e.data : await e.data.text();
    const msg = await secureReceive(rawData);
    if (!msg) return;
    // Handle key-exchange first
    if (msg.type === 'key-exchange') {
      await handleKeyExchange(msg);
      return;
    }
    // After encryption established, send deferred auth
    if (msg.type === 'encrypted' && msg.status === 'ok' && pendingAuth) {
      const { method: m, totpCode: tc } = pendingAuth;
      pendingAuth = null;
      if (m === 'reconnect' && sessionToken) {
        queueSend({ type: 'auth', sessionToken });
      } else if (m === 'passkey' && sessionToken) {
        queueSend({ type: 'auth-passkey', sessionToken });
      } else if (m === 'totp' && tc) {
        queueSend({ type: 'auth', totp: tc });
      } else if (sessionToken) {
        queueSend({ type: 'auth', sessionToken });
      } else {
        showStatus('Please authenticate', 'var(--dim)');
      }
      return;
    }
    handle(msg);
  };
}

// ── Notifications ──
// Request permission on first user interaction
let notifPermission = typeof Notification !== 'undefined' ? Notification.permission : 'denied';
document.addEventListener('click', function reqNotif() {
  if (typeof Notification !== 'undefined' && notifPermission === 'default') {
    Notification.requestPermission().then(p => { notifPermission = p; });
  }
  document.removeEventListener('click', reqNotif);
}, { once: true });

const ATTN_LABELS = {
  ready: 'Claude is ready',
  permission: 'Permission needed',
  question: 'Claude has a question'
};

const ATTN_VIBRATE = {
  ready: [100, 50, 100],
  permission: [200, 100, 200, 100, 200],
  question: [150, 80, 150]
};

function notifyAttention(sessionId, reason, sessionName) {
  // Vibrate with pattern based on reason
  if (navigator.vibrate) navigator.vibrate(ATTN_VIBRATE[reason] || [200]);

  // System notification when page is not visible (phone locked, other app)
  if (document.hidden && notifPermission === 'granted') {
    const title = ATTN_LABELS[reason] || 'Attention needed';
    const body = sessionName ? `Session: ${sessionName}` : `Session ${sessionId}`;
    try {
      const n = new Notification(title, { body, tag: `attn-${sessionId}`, renotify: true });
      n.onclick = () => { window.focus(); n.close(); };
    } catch (e) { console.warn('Notification failed:', e.message); }
  }
}

function handle(m) {
  switch (m.type) {
    case 'auth':
      if (m.success) {
        decryptReconnectCount = 0;
        if (m.sessionToken) sessionToken = m.sessionToken;
        if (m.inactivityMs) inactivityMs = m.inactivityMs;
        $('totp-input').value = '';
        // classList, not style.display: an inline display outranks every
        // stylesheet rule and would silently pin #app to flex, so the
        // landscape rail could never apply.
        authScreen.style.display = 'none'; appEl.classList.add('shown');
        loadProjects();
        scheduleTokenRefresh(m.ttl);
        resetInactivityTimer();
        if (activeSession !== null) queueSend({ type: 'connect', session: activeSession, renderer: RENDERER_MODE });
        // Server may send locked=true if token was inactive during disconnect
        if (m.locked) showLockScreen();
        if (m.hasTotp && !m.hasPasskey && window.PublicKeyCredential && !localStorage.getItem('passkey-dismissed')) {
          // Defer passkey prompt until user interacts (confirm() blocks JS and iOS kills WS)
          localStorage.setItem('passkey-dismissed', '1');
        }
      } else {
        setAuthMode('login'); authScreen.style.display = 'flex'; appEl.classList.remove('shown');
        $('totp-input').value = '';
        authError.style.display = 'block'; sessionToken = null;
        if (m.locked) showStatus('Too many attempts. Locked out.', 'var(--intent-danger-text)');
        if (m.reason) showStatus(m.reason, 'var(--intent-danger-text)');
        checkAuthStatus();
      }
      break;
    case 'expired':
      setAuthMode('login'); authScreen.style.display = 'flex'; appEl.classList.remove('shown');
      sessionToken = null;
      $('totp-input').value = '';
      authError.style.display = 'none';
      showStatus('Session expired. Re-authenticate.', 'var(--intent-warn-text)');
      checkAuthStatus();
      break;
    case 'refreshed':
      if (m.sessionToken) {
        sessionToken = m.sessionToken;
        scheduleTokenRefresh(m.ttl);
      }
      break;
    case 'lock':
      showLockScreen();
      break;
    case 'unlocked':
      hideLockScreen();
      break;
    case 'warning':
      console.warn('Server warning:', m.message);
      break;
    case 'sessions':
      sessionList = m.sessions; renderTabs(); updateHdr();
      if (!sessionList.length) { activeSession = null; emptyState.style.display = 'flex'; }
      else if (activeSession === null) switchTo(sessionList[0].id);
      break;
    case 'created':
      switchTo(m.session); break;
    case 'output':
      if (terms[m.session]) {
        let q = pendingTermWrites.get(m.session);
        if (!q) { q = []; pendingTermWrites.set(m.session, q); }
        q.push(m.data);
        scheduleTerminalFlush();
      }
      break;
    case 'snapshot':
      if (gridTerms[m.session]) queueGridSnapshot(gridTerms[m.session], m);
      break;
    case 'frame':
      if (gridTerms[m.session]) queueGridFrame(gridTerms[m.session], m);
      break;
    case 'mouse-mode':
      if (gridTerms[m.session] && m.mouse) {
        gridTerms[m.session].mouse = m.mouse;
        applyGridMouseMode(gridTerms[m.session]);
        syncFocusReport();   // T08: mouse.focus carries CSI ?1004h/l
      }
      break;
    case 'scrollback':
      if (terms[m.session] && m.data) {
        const term = terms[m.session];
        term.reset();
        const lines = m.data.split('\n');
        const CHUNK = 50;
        let i = 0;
        function writeNextChunk() {
          if (i >= lines.length) {
            term.scrollToBottom();
            return;
          }
          const chunk = lines.slice(i, i + CHUNK).join('\n');
          i += CHUNK;
          const separator = (i < lines.length) ? '\n' : '';
          term.write(chunk + separator, writeNextChunk);
        }
        writeNextChunk();
      }
      break;
    case 'attention':
      const s = sessionList.find(x => x.id === m.session);
      if (s) { s.attention = m.reason; renderTabs(); }
      notifyAttention(m.session, m.reason, s?.name);
      break;
    case 'commands':
      if (m.commands && Array.isArray(m.commands)) commands = m.commands;
      break;
    case 'error':
      // Ignore lock/auth errors (handled by lock screen) -- don't block with alert()
      if (/locked|re-authenticate|not authenticated/i.test(m.message)) break;
      showStatus(m.message, 'var(--intent-danger-text)');
      break;
  }
}

async function loadProjects() {
  try {
    const res = await fetch('/api/config', { headers: { 'X-Session-Token': sessionToken } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    projects = (await res.json()).projects;
  } catch (e) {
    clientLog('loadProjects failed: ' + e.message);
  }
}

// T05: ONE terminal palette. The colours live in style.css's :root token
// block (--term-*, --ansi-0..15, --font-mono) and nowhere else; this reads
// them once and both renderers -- the grid (sgrColorToHex/applySgr) and the
// xterm fallback (getTermTheme) -- take them from here, so JS and CSS cannot
// drift. The stylesheet is render-blocking in <head> and app.js loads at the
// end of <body>, so the computed values exist on first call.
let termPaletteCache = null;
function termPalette() {
  if (termPaletteCache) return termPaletteCache;
  const cs = getComputedStyle(document.documentElement);
  const v = name => cs.getPropertyValue(name).trim();
  const ansi = [];
  for (let i = 0; i < 16; i++) ansi.push(v('--ansi-' + i));
  termPaletteCache = {
    bg: v('--term-bg'), fg: v('--term-fg'),
    cursor: v('--term-cursor'), selection: v('--term-selection'),
    fontMono: v('--font-mono'),
    ansi,
  };
  return termPaletteCache;
}

const XTERM_ANSI_NAMES = [
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow',
  'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'
];

function getTermTheme() {
  const p = termPalette();
  const theme = {
    background: p.bg, foreground: p.fg, cursor: p.cursor,
    selectionBackground: p.selection,
  };
  XTERM_ANSI_NAMES.forEach((name, i) => { theme[name] = p.ansi[i]; });
  return theme;
}

// T08 of W3 (render-pipeline): shared rAF scheduler. scheduleOnce(fn) runs
// fn at most once on the next animation frame (Set-based dedup; reusing
// the same function reference within a frame coalesces). requestLive(fn) /
// dropLive(fn) keep a ref-counted persistent loop for animations
// (no callers yet; reserved for W7 rope-tail). The shared loop stops
// when both queues are empty.
const liveSubscribers = new Set();
const onceQueue = new Set();
let frameRaf = 0;

function tickFrame() {
  frameRaf = 0;
  const once = Array.from(onceQueue);
  onceQueue.clear();
  for (const fn of once) {
    try { fn(); } catch (e) { clientLog('frame once: ' + e.message); }
  }
  for (const fn of liveSubscribers) {
    try { fn(); } catch (e) { clientLog('frame live: ' + e.message); }
  }
  if (liveSubscribers.size > 0 || onceQueue.size > 0) {
    frameRaf = requestAnimationFrame(tickFrame);
  }
}

function ensureFrame() {
  if (frameRaf === 0) frameRaf = requestAnimationFrame(tickFrame);
}

function scheduleOnce(fn) {
  onceQueue.add(fn);
  ensureFrame();
}

function requestLive(fn) {
  liveSubscribers.add(fn);
  ensureFrame();
}

function dropLive(fn) {
  liveSubscribers.delete(fn);
}

// T03 of W1 (render-pipeline): coalesce client-side term.write into one
// call per session per animation frame. Pairs with server-side coalescer
// (T02, server.js). The scroll-preserve hack now runs once per frame
// instead of once per WS message. T09 of W3 routes the rAF through the
// shared scheduleOnce above.
const pendingTermWrites = new Map();  // Map<sessionId, string[]>

function flushTerminalWrites() {
  const entries = Array.from(pendingTermWrites);
  pendingTermWrites.clear();
  for (const [sid, chunks] of entries) {
    const term = terms[sid];
    if (!term || chunks.length === 0) continue;
    const data = chunks.join('');
    if (sid === activeSession && userScrolled) {
      const vp = term.element?.querySelector('.xterm-viewport');
      const pos = vp?.scrollTop;
      term.write(data);
      if (vp && pos !== undefined) vp.scrollTop = pos;
    } else {
      term.write(data);
      if (sid === activeSession) {
        term.scrollToBottom();
        window.scrollTo(0, 0);
      }
    }
  }
}

function scheduleTerminalFlush() {
  scheduleOnce(flushTerminalWrites);
}

// T19 + T20 of W5 (render-pipeline): grid renderer factory + Snapshot /
// Frame application. Pure DOM, no VT logic -- the server's @xterm/headless
// produces the cell grid; this side only renders styled cells.
//
// Colour encoding mirrors server cellToSgr:
//   0..15            = ANSI palette: termPalette().ansi (style.css --ansi-N)
//   16..255          = xterm cube + grayscale, computed (not themed)
//   0x1000000+rrggbb = 24-bit RGB
// Standard xterm 256-color cube levels for indexes 16..231 (6x6x6).
const XTERM_CUBE_LEVELS = [0, 95, 135, 175, 215, 255];
const SGR_RGB_FLAG = 0x1000000;
// Removed in T31: viewport culling makes the per-row mount cost bounded, so
// we render all 5000 server-side scrollback rows. See GRID_MAX_ROWS.

function hex2(n) { return n.toString(16).padStart(2, '0'); }

function sgrColorToHex(value) {
  if (value >= SGR_RGB_FLAG) return '#' + (value & 0xFFFFFF).toString(16).padStart(6, '0');
  if (value >= 0 && value < 16) return termPalette().ansi[value];
  if (value >= 16 && value < 232) {
    // 6x6x6 color cube: index = 16 + 36*r + 6*g + b
    const i = value - 16;
    const r = XTERM_CUBE_LEVELS[Math.floor(i / 36)];
    const g = XTERM_CUBE_LEVELS[Math.floor((i % 36) / 6)];
    const b = XTERM_CUBE_LEVELS[i % 6];
    return '#' + hex2(r) + hex2(g) + hex2(b);
  }
  if (value >= 232 && value < 256) {
    // 24-step grayscale ramp.
    const v = 8 + (value - 232) * 10;
    return '#' + hex2(v) + hex2(v) + hex2(v);
  }
  return null;
}

function applySgr(span, sgr) {
  if (!sgr) return;
  let fg = sgr.fg !== undefined ? sgrColorToHex(sgr.fg) : null;
  let bg = sgr.bg !== undefined ? sgrColorToHex(sgr.bg) : null;
  // SGR 7: reverse swaps fg/bg, defaults filled from theme so the swap is
  // visible even when both sides were "default".
  if (sgr.reverse) {
    const newFg = bg !== null ? bg : termPalette().bg;
    const newBg = fg !== null ? fg : termPalette().fg;
    fg = newFg;
    bg = newBg;
  }
  // T11: one style write per span, not one per property.
  let css = '';
  if (fg !== null) css += 'color:' + fg + ';';
  if (bg !== null) css += 'background-color:' + bg + ';';
  if (sgr.bold) css += 'font-weight:bold;';
  if (sgr.italic) css += 'font-style:italic;';
  if (sgr.underline) css += 'text-decoration:underline;';
  if (css) span.style.cssText = css;
  // sgr.hyperlink handled in renderRow (T21).
}

// Terminal output is untrusted: any OSC 8 escape Claude prints -- from a
// README, a fetched page, a package name -- reaches renderRow. Assigning it
// straight to el.href admits javascript: and data: URIs into the
// authenticated origin. Parse with the URL API rather than matching the raw
// string: the parser strips embedded tab/CR/LF, so "java\nscript:" cannot
// slip a regex.
const SAFE_LINK_SCHEMES = ['http:', 'https:', 'mailto:'];
function safeHref(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const u = new URL(raw, location.href);
    return SAFE_LINK_SCHEMES.includes(u.protocol) ? u.href : null;
  } catch (e) { return null; }
}

// T11: true when applySgr would set nothing on the element.
function sgrIsPlain(sgr) {
  return !sgr || (sgr.fg === undefined && sgr.bg === undefined && !sgr.reverse &&
                  !sgr.bold && !sgr.italic && !sgr.underline);
}

// T11: a run with no visible styling needs no element of its own. The server
// already merges runs with identical SGR, so what is left to save is the
// element per unstyled run (usually the whole trailing pad of every row), and
// adjacent unstyled runs that differed only in a hyperlink safeHref refused.
// Those become one text node -- fewer boxes to style, lay out and paint.
function renderRow(runs) {
  const div = document.createElement('div');
  div.className = 'grid-row';
  let plain = '';
  for (const run of runs) {
    // T21: cells inside an OSC 8 link become anchors instead of spans.
    const href = run.sgr && run.sgr.hyperlink ? safeHref(run.sgr.hyperlink) : null;
    if (!href && sgrIsPlain(run.sgr)) { plain += run.text; continue; }
    if (plain) { div.appendChild(document.createTextNode(plain)); plain = ''; }
    let el;
    if (href) {
      el = document.createElement('a');
      el.href = href;
      el.target = '_blank';
      el.rel = 'noopener noreferrer';
    } else {
      el = document.createElement('span');
    }
    el.textContent = run.text;
    applySgr(el, run.sgr);
    div.appendChild(el);
  }
  if (plain) div.appendChild(document.createTextNode(plain));
  return div;
}

// T31: viewport culling. The wrap holds two empty spacer divs flanking the
// mounted-row range. Spacer heights stand in for unmounted rows so scrollHeight
// stays accurate without keeping every row in the DOM. On scroll, the visible
// window is recomputed and only [firstVisible-overscan, lastVisible+overscan]
// rows are mounted; everything else lives in grid.allRows[] until scrolled to.
const GRID_OVERSCAN = 10;
const GRID_MAX_ROWS = 5000;  // matches server's HeadlessTerminal scrollback cap
const GRID_ROW_HEIGHT_FALLBACK = 17;

function makeGridTerm() {
  const wrap = document.createElement('div');
  wrap.className = 'grid-term';
  const topSpacer = document.createElement('div');
  topSpacer.className = 'grid-spacer';
  topSpacer.style.height = '0px';
  const bottomSpacer = document.createElement('div');
  bottomSpacer.className = 'grid-spacer';
  bottomSpacer.style.height = '0px';
  const cursorEl = document.createElement('div');
  cursorEl.className = 'grid-cursor';
  wrap.appendChild(topSpacer);
  wrap.appendChild(bottomSpacer);
  wrap.appendChild(cursorEl);

  const grid = {
    wrap, topSpacer, bottomSpacer, cursorEl,
    allRows: [],            // ordered {row, runs} for entire scrollback+viewport
    rowIndexByServerRow: new Map(),  // server row -> index in allRows
    mountedEls: [],         // currently mounted DOM rows in display order
    mountedStart: 0,        // index in allRows of first mounted row
    mountedCount: 0,
    rowEls: new Map(),      // server row -> mounted DOM element
    rowHeight: 0,
    charWidth: 0,
    cols: 0, rows: 0,
    cursor: { row: 0, col: 0, visible: true },
    // T22: what the application has asked to hear, as told by the server.
    // Starts at none so a pane reports nothing until it says otherwise.
    mouse: { tracking: 'none', encoding: 'default' },
    scrollScheduled: false,
    // T30 substitute: rAF-coalesced frame queue. Multiple frames arriving
    // within one paint window merge to a single applyGridFrame call.
    // T11: a snapshot rides the same rAF. It supersedes every frame queued
    // before it; frames queued after it apply after it, in that callback.
    pendingFrames: [],
    pendingSnapshot: null,
    frameRafScheduled: false,
    // T11: last cursor style written, so an unmoved cursor costs no write.
    cursorCss: '',
  };

  wrap.addEventListener('scroll', () => {
    if (grid.scrollScheduled) return;
    grid.scrollScheduled = true;
    requestAnimationFrame(() => {
      grid.scrollScheduled = false;
      renderGridWindow(grid);
    });
  }, { passive: true });

  // Re-window on any size transition: hidden->visible (session switch),
  // orientation change, soft-keyboard show/hide. Without this, a snapshot
  // landing while term-wrap is display:none computes mountedCount=10
  // (overscan only) from clientHeight=0 and stays stuck on re-show.
  // Also re-runs doResize so we re-assert mobile dimensions when becoming
  // visible -- another client connected to the same session may have
  // resized the PTY in the meantime.
  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(() => {
      if (grid.scrollScheduled) return;
      grid.scrollScheduled = true;
      requestAnimationFrame(() => {
        grid.scrollScheduled = false;
        renderGridWindow(grid);
        if (typeof doResize === 'function' && wrap.clientWidth > 0) doResize();
      });
    });
    ro.observe(wrap);
    grid.resizeObserver = ro;
  }

  attachGridMouse(grid);

  return grid;
}

// Measures one monospace cell inside `container`, at whatever font the
// container currently resolves. T14 made the font size a setting, so every
// cols/rows calculation has to go through a live probe -- the old hardcoded
// 7.8px in newSession() was only ever right at 13px.
function probeCell(container) {
  const probe = document.createElement('span');
  probe.style.cssText = 'position:absolute;visibility:hidden;font:inherit;line-height:inherit;white-space:pre';
  probe.textContent = 'X';
  container.appendChild(probe);
  const r = probe.getBoundingClientRect();
  container.removeChild(probe);
  return { w: r.width, h: r.height };
}

// T11: cell metrics are probed once and cached on the grid. A probe is a
// forced layout, and it used to run on every snapshot and (via the cursor)
// every frame. The inputs that can change a cell are the font size (the
// setting), the font itself (a late-resolving system font) and the device
// pixel ratio (zoom, display change); each of those invalidates the cache.
// Both numbers come from one probe, so the renderer, the cursor and
// gridCellFromEvent always agree. A probe on a hidden wrap measures 0 and is
// NOT cached -- the next visible call measures for real.
function probeGridMetrics(grid) {
  if (grid.charWidth > 0 && grid.rowHeight > 0) return true;
  const cell = document.createElement('span');
  cell.style.cssText = 'position:absolute;visibility:hidden;font:inherit;line-height:inherit;white-space:pre';
  cell.textContent = 'X';
  const row = document.createElement('div');
  row.className = 'grid-row';
  row.style.cssText = 'position:absolute;visibility:hidden';
  row.appendChild(document.createTextNode('X'));
  grid.wrap.appendChild(cell);
  grid.wrap.appendChild(row);
  const w = cell.getBoundingClientRect().width;
  const h = row.getBoundingClientRect().height;
  grid.wrap.removeChild(cell);
  grid.wrap.removeChild(row);
  if (w > 0 && h > 0) {
    grid.charWidth = w;
    grid.rowHeight = h;
    return true;
  }
  return false;
}

function measureCharWidth(grid) {
  probeGridMetrics(grid);
  return grid.charWidth;
}

function ensureRowHeight(grid) {
  return probeGridMetrics(grid) ? grid.rowHeight : GRID_ROW_HEIGHT_FALLBACK;
}

function invalidateGridMetrics() {
  Object.keys(gridTerms).forEach(id => {
    gridTerms[id].charWidth = 0;
    gridTerms[id].rowHeight = 0;
  });
}

// Font or pixel grid changed under the grid: drop the cache and re-window
// (row height may differ), then let doResize tell the server if the cell
// count moved.
function remeasureGrids() {
  invalidateGridMetrics();
  scheduleOnce(() => {
    Object.keys(gridTerms).forEach(id => renderGridWindow(gridTerms[id]));
    doResize();
  });
}

// DPR changes (browser zoom, moving to another display) re-rasterise the
// font on a different pixel grid. The query is pinned to one ratio, so it
// re-arms itself on each change.
function watchDevicePixelRatio() {
  if (!window.matchMedia) return;
  const mq = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
  if (!mq.addEventListener) return;
  mq.addEventListener('change', function onChange() {
    mq.removeEventListener('change', onChange);
    remeasureGrids();
    watchDevicePixelRatio();
  });
}
watchDevicePixelRatio();
if (document.fonts && document.fonts.addEventListener) {
  document.fonts.addEventListener('loadingdone', remeasureGrids);
}

// ─── T22: mouse reporting ────────────────────────────────────────
//
// herdr asks for any-event tracking with SGR encoding the moment it starts,
// so until now every tap inside a pane went nowhere -- the recorded reason
// herdr felt bad on the iPad. Events are forwarded ONLY while the app has
// actually asked for them; otherwise the pane keeps its ordinary scrolling
// and text selection, which is what a shell session wants.
//
// The server decides how to spell an event. The client's job is to say where
// it happened, in cells, and to not say it too often.

const GRID_MOUSE_BUTTONS = ['left', 'middle', 'right'];

// A pointer position as a 1-based pty cell, or null if it is not over an
// addressable one.
//
// Resolved from geometry rather than from the element under the pointer.
// setPointerCapture retargets every subsequent event to the wrap, so
// `e.target.closest('.grid-row')` is null for the whole of a drag -- which is
// exactly the gesture herdr uses to resize a split, so the element-based
// version dropped the events that matter most. The row stack is a flat run of
// equal-height rows and `.grid-term` carries no padding, so index * rowHeight
// is the same model the renderer's own scroll anchoring already uses.
//
// Scrollback rows carry a negative server row and are deliberately excluded:
// the application owns the viewport only, and telling it about a click on a
// row it has already forgotten would name the wrong cell rather than none.
function gridCellFromEvent(grid, e) {
  const charW = measureCharWidth(grid);
  const rowH = ensureRowHeight(grid);
  if (!charW || !rowH || !grid.allRows.length) return null;
  const r = grid.wrap.getBoundingClientRect();
  const idx = Math.floor((e.clientY - r.top + grid.wrap.scrollTop) / rowH);
  if (idx < 0 || idx >= grid.allRows.length) return null;
  const serverRow = grid.allRows[idx].row;
  if (serverRow < 0) return null;
  let col = Math.floor((e.clientX - r.left + grid.wrap.scrollLeft) / charW) + 1;
  if (col < 1) col = 1;
  if (grid.cols && col > grid.cols) col = grid.cols;
  return { col, row: serverRow + 1 };
}

function gridMouseWants(grid) {
  return !!(grid.mouse && grid.mouse.tracking && grid.mouse.tracking !== 'none');
}

// touch-action must be surrendered before the gesture starts, not during it:
// once Safari has claimed a touch for scrolling, preventDefault on a later
// move cannot take it back.
function applyGridMouseMode(grid) {
  if (!grid.wrap) return;
  grid.wrap.classList.toggle('mouse-active', gridMouseWants(grid));
}

function attachGridMouse(grid) {
  const wrap = grid.wrap;
  let heldButton = null;
  let lastCell = null;
  let pendingMove = null;
  let moveRaf = 0;

  function emit(action, e, cell, extra) {
    const msg = {
      type: 'mouse', action,
      button: action === 'wheel' ? null
        : (heldButton !== null ? heldButton : (GRID_MOUSE_BUTTONS[e.button] || 'left')),
      col: cell.col, row: cell.row,
      shift: !!e.shiftKey, alt: !!e.altKey, ctrl: !!e.ctrlKey,
    };
    if (extra) Object.assign(msg, extra);
    queueSend(msg);
  }

  wrap.addEventListener('pointerdown', (e) => {
    if (!gridMouseWants(grid)) return;
    const cell = gridCellFromEvent(grid, e);
    if (!cell) return;
    e.preventDefault();
    heldButton = GRID_MOUSE_BUTTONS[e.button] || 'left';
    lastCell = cell;
    emit('down', e, cell);
    // Capture keeps a drag that leaves the element reporting to us rather
    // than stopping dead at the edge, which is what a pane resize needs.
    try { wrap.setPointerCapture(e.pointerId); } catch (err) { /* not fatal */ }
  }, { passive: false });

  wrap.addEventListener('pointermove', (e) => {
    if (!gridMouseWants(grid)) return;
    // Which motion the app wants is decided by the mode it asked for. Asking
    // the server per pixel would be a round trip per pixel.
    const t = grid.mouse.tracking;
    if (t === 'x10' || t === 'vt200') return;
    if (t === 'drag' && heldButton === null) return;
    pendingMove = e;
    if (moveRaf) return;
    // Any-event tracking fires on every pixel of a drag. One message per
    // frame, and only when the CELL changed, is all the application can
    // distinguish -- and the difference matters over a VPN.
    moveRaf = requestAnimationFrame(() => {
      moveRaf = 0;
      const ev = pendingMove;
      pendingMove = null;
      if (!ev || !gridMouseWants(grid)) return;
      const cell = gridCellFromEvent(grid, ev);
      if (!cell) return;
      if (lastCell && cell.col === lastCell.col && cell.row === lastCell.row) return;
      lastCell = cell;
      emit('move', ev, cell);
    });
  }, { passive: true });

  function endPointer(e, send) {
    if (moveRaf) { cancelAnimationFrame(moveRaf); moveRaf = 0; pendingMove = null; }
    if (send && gridMouseWants(grid)) {
      const cell = gridCellFromEvent(grid, e) || lastCell;
      if (cell) { e.preventDefault(); emit('up', e, cell); }
    }
    heldButton = null;
    lastCell = null;
    try { wrap.releasePointerCapture(e.pointerId); } catch (err) { /* already gone */ }
  }

  wrap.addEventListener('pointerup', (e) => endPointer(e, true), { passive: false });
  // A cancelled pointer (a system gesture, a call arriving) never produces a
  // pointerup. Releasing the button locally without reporting one would leave
  // the app holding a drag forever, so the release is sent here too.
  wrap.addEventListener('pointercancel', (e) => endPointer(e, true), { passive: false });

  wrap.addEventListener('wheel', (e) => {
    if (!gridMouseWants(grid)) return;
    const cell = gridCellFromEvent(grid, e);
    if (!cell) return;
    e.preventDefault();
    emit('wheel', e, cell, { delta: e.deltaY < 0 ? -1 : 1 });
  }, { passive: false });

  // The context menu on a long press would otherwise interrupt a right-drag.
  wrap.addEventListener('contextmenu', (e) => {
    if (gridMouseWants(grid)) e.preventDefault();
  });
}

function unmountAllGridRows(grid) {
  for (const el of grid.mountedEls) el.remove();
  grid.mountedEls = [];
  grid.rowEls.clear();
}

function renderGridWindow(grid) {
  if (!grid.allRows.length) {
    unmountAllGridRows(grid);
    grid.topSpacer.style.height = '0px';
    grid.bottomSpacer.style.height = '0px';
    grid.mountedStart = 0;
    grid.mountedCount = 0;
    updateGridCursor(grid);
    return;
  }
  // Reads first: every caller runs this at the top of a frame, before its
  // own writes, so these come off the layout the browser already has.
  const rowH = ensureRowHeight(grid);
  mountGridWindow(grid, rowH, grid.wrap.scrollTop, grid.wrap.clientHeight);
}

// T11: writes only. The window is computed from numbers the caller already
// read, so mounting never reads layout back after mutating it.
function mountGridWindow(grid, rowH, scrollTop, clientH) {
  const total = grid.allRows.length;
  const firstVisible = Math.floor(scrollTop / rowH);
  const lastVisible = Math.ceil((scrollTop + clientH) / rowH);
  const mountStart = Math.max(0, firstVisible - GRID_OVERSCAN);
  const mountEnd = Math.min(total, lastVisible + GRID_OVERSCAN);
  const mountCount = mountEnd - mountStart;

  if (mountStart === grid.mountedStart && mountCount === grid.mountedCount && grid.mountedEls.length === mountCount) {
    updateGridCursor(grid);
    return;
  }

  unmountAllGridRows(grid);
  grid.topSpacer.style.height = (mountStart * rowH) + 'px';
  grid.bottomSpacer.style.height = ((total - mountEnd) * rowH) + 'px';

  const fragment = document.createDocumentFragment();
  for (let i = mountStart; i < mountEnd; i++) {
    const rc = grid.allRows[i];
    const el = renderRow(rc.runs);
    fragment.appendChild(el);
    grid.mountedEls.push(el);
    grid.rowEls.set(rc.row, el);
  }
  grid.bottomSpacer.before(fragment);
  grid.mountedStart = mountStart;
  grid.mountedCount = mountCount;
  updateGridCursor(grid);
}

// T11: the cursor is placed by transform from the cached cell metrics, not by
// reading the row's offsetTop -- that read came straight after replaceWith
// and forced a synchronous layout on almost every frame. Rows are a flat
// stack of fixed-height boxes (.grid-row height is 1.286em, the probed
// rowHeight), so row index * rowHeight IS the row's offsetTop; the same model
// the spacers, scroll anchoring and gridCellFromEvent use. Unmoved cursor, no
// write. The blink is an opacity animation in style.css, so neither the move
// nor the blink needs layout or paint.
function updateGridCursor(grid) {
  const c = grid.cursor;
  const rowH = grid.rowHeight, charW = grid.charWidth;
  let css = 'display:none';
  if (c && c.visible && rowH > 0 && charW > 0) {
    const idx = grid.rowIndexByServerRow.get(c.row);
    if (idx !== undefined && idx >= grid.mountedStart && idx < grid.mountedStart + grid.mountedCount) {
      css = `display:block;height:${rowH}px;transform:translate3d(${c.col * charW}px,${idx * rowH}px,0)`;
    }
  }
  if (css === grid.cursorCss) return;
  grid.cursorCss = css;
  grid.cursorEl.style.cssText = css;
}

// The useful part of a working directory is its tail, but CSS left-truncation
// (`direction: rtl` + ellipsis) reorders the leading slash to the end on a
// path, rendering "…sers/MRAL-/Projects/loomi-os/". Trim in JS instead; the
// full path stays available as a title attribute.
function shortDir(dir) {
  if (!dir) return '';
  const parts = dir.split('/').filter(Boolean);
  if (parts.length <= 2) return dir;
  return '.../' + parts.slice(-2).join('/');
}

// Within this many px of the bottom counts as "following the output", which is
// the state a terminal should keep scrolling in. Anything above it means the
// reader is looking at something and must not be moved.
const GRID_STICK_PX = 8;

function applyGridSnapshot(grid, snap) {
  // A snapshot must not move the reader. Snapshots arrive on every tab return
  // and every session switch, so unconditionally scrolling to the bottom threw
  // the scroll position away several times an hour -- measured at +7,230px on
  // an 11" iPad. Capture the anchor BEFORE anything is reset, and restore it
  // by server row ID: row indices shift when scrollback rolls, IDs do not.
  //
  // T11: every layout read happens here, before the first write. Snapshots are
  // applied at the top of a frame (queueGridSnapshot), so these reads come off
  // the layout the browser already has. The bottom and the anchor are then
  // COMPUTED from row count * rowHeight rather than read back from
  // scrollHeight after mutating -- that read-after-write, plus the per-snapshot
  // cell probes, cost ~4 forced layouts per snapshot.
  grid.pendingSnapshot = null;
  // Snapshots fully reset state; any frames still queued from before this
  // snapshot are stale and would re-apply changes already covered.
  grid.pendingFrames.length = 0;
  const w = grid.wrap;
  const scrollTop = w.scrollTop, clientH = w.clientHeight, scrollH = w.scrollHeight;
  const wasAtBottom = !scrollH || (scrollH - scrollTop - clientH) <= GRID_STICK_PX;
  const oldRowH = grid.rowHeight || 0;
  let anchorRow = null, anchorOffset = 0;
  if (!wasAtBottom && oldRowH > 0 && grid.allRows.length) {
    const topIdx = Math.min(grid.allRows.length - 1,
      Math.max(0, Math.floor(scrollTop / oldRowH)));
    anchorRow = grid.allRows[topIdx].row;
    anchorOffset = scrollTop - topIdx * oldRowH;
  }
  // Cached: re-probes only after a font, font-size or DPR change, or when the
  // last probe ran on a hidden wrap. Still ahead of every write below.
  const rowH = ensureRowHeight(grid);

  grid.cols = snap.cols;
  grid.rows = snap.rows;
  grid.cursor = snap.cursor;
  // T22: a snapshot is the full truth about the pane, mouse mode included --
  // it is how a client that connects mid-session learns the app is listening.
  if (snap.mouse) { grid.mouse = snap.mouse; applyGridMouseMode(grid); syncFocusReport(); }

  // Build full row list. Server row indices: scrollback < 0, viewport 0..rows-1.
  const sb = snap.scrollback.slice(-GRID_MAX_ROWS);
  grid.allRows = sb.concat(snap.viewport);
  grid.rowIndexByServerRow.clear();
  for (let i = 0; i < grid.allRows.length; i++) {
    grid.rowIndexByServerRow.set(grid.allRows[i].row, i);
  }

  // Rows are fixed-height, so the content height is exact and the bottom is
  // totalH - clientH -- no scrollHeight read needed.
  const maxTop = Math.max(0, grid.allRows.length * rowH - clientH);
  let top = maxTop;
  if (anchorRow !== null) {
    const idx = grid.rowIndexByServerRow.get(anchorRow);
    // undefined means the anchored row has aged out of scrollback entirely --
    // there is no position left to hold, so following the output is correct.
    if (idx !== undefined) top = Math.min(maxTop, Math.max(0, idx * rowH + anchorOffset));
  }

  unmountAllGridRows(grid);
  grid.mountedStart = 0;
  grid.mountedCount = 0;
  mountGridWindow(grid, rowH, top, clientH);
  // Last, and only if it moves: the one write that needs the new layout.
  if (Math.abs(scrollTop - top) >= 1) w.scrollTop = top;
}

function applyGridFrame(grid, frame) {
  // No-op while the metrics are cached; if a font change dropped them, the
  // probe runs here, ahead of every write.
  probeGridMetrics(grid);
  grid.cursor = frame.cursor;
  for (const rc of frame.changes) {
    const idx = grid.rowIndexByServerRow.get(rc.row);
    if (idx === undefined) continue;
    grid.allRows[idx] = rc;
    if (idx >= grid.mountedStart && idx < grid.mountedStart + grid.mountedCount) {
      const newEl = renderRow(rc.runs);
      const existing = grid.rowEls.get(rc.row);
      if (existing) {
        existing.replaceWith(newEl);
        grid.mountedEls[idx - grid.mountedStart] = newEl;
      }
      grid.rowEls.set(rc.row, newEl);
    }
  }
  updateGridCursor(grid);
}

// T30 substitute: coalesce frames arriving within the same paint window into
// one applyGridFrame call. Reduces JS DOM mutation work during burst streams
// (claude-code token output emits frames faster than rAF can paint). Merge
// rule: latest-wins per row index; latest cursor wins; seq tracks the most
// recent merged frame.
//
// T11: snapshots go through the same rAF. Arrival order is preserved: a
// snapshot discards every frame queued before it (it already contains them),
// and frames that arrive after it -- before the rAF fires -- apply on top of
// it in the same callback. A later snapshot replaces an earlier pending one.
function queueGridFrame(grid, frame) {
  grid.pendingFrames.push(frame);
  scheduleGridFlush(grid);
}

function queueGridSnapshot(grid, snap) {
  grid.pendingSnapshot = snap;
  grid.pendingFrames.length = 0;
  scheduleGridFlush(grid);
}

function scheduleGridFlush(grid) {
  if (grid.frameRafScheduled) return;
  grid.frameRafScheduled = true;
  requestAnimationFrame(() => flushGrid(grid));
}

function flushGrid(grid) {
  grid.frameRafScheduled = false;
  const snap = grid.pendingSnapshot;
  const frames = grid.pendingFrames;
  grid.pendingSnapshot = null;
  grid.pendingFrames = [];
  if (snap) applyGridSnapshot(grid, snap);
  if (frames.length) applyGridFrame(grid, mergeFrames(frames));
}

function mergeFrames(frames) {
  if (frames.length === 1) return frames[0];
  const last = frames[frames.length - 1];
  const rowMap = new Map();
  for (const f of frames) {
    for (const ch of f.changes) rowMap.set(ch.row, ch);
  }
  return {
    type: 'frame',
    session: last.session,
    changes: Array.from(rowMap.values()),
    cursor: last.cursor,
    seq: last.seq,
  };
}

function makeTerm() {
  const term = new Terminal({
    fontSize: 13,
    fontFamily: termPalette().fontMono,
    lineHeight: 1.286,
    theme: getTermTheme(),
    scrollback: 10000,
    convertEol: true,
    disableStdin: true,
    cursorBlink: false,
    cursorStyle: 'bar',
    allowProposedApi: true
  });
  return term;
}

function switchTo(id) {
  activeSession = id;
  document.querySelectorAll('.term-wrap').forEach(el => el.classList.remove('active'));

  if (RENDERER_MODE === 'grid' && !gridTerms[id]) {
    // T19 of W5: grid renderer mount. The wrap is scrollable; the grid
    // renderer handles scroll itself (no fit addon, no WebGL/Canvas).
    const wrap = document.createElement('div');
    wrap.className = 'term-wrap';
    wrap.id = `tw-${id}`;
    termArea.appendChild(wrap);
    const grid = makeGridTerm();
    wrap.appendChild(grid.wrap);
    gridTerms[id] = grid;
    // Touches inside the grid wrap propagate freely to the document-level
    // swipe-to-switch handler. That handler is passive:true and only locks
    // horizontal when dx > dy*1.5, so it cannot fight native vertical scroll
    // on .grid-term. The earlier defensive stopPropagation here blocked
    // swipe-to-switch entirely once 3.2.9 hid the scroll-zones passthrough.
  } else if (RENDERER_MODE !== 'grid' && !terms[id]) {
    const wrap = document.createElement('div');
    wrap.className = 'term-wrap';
    wrap.id = `tw-${id}`;
    termArea.appendChild(wrap);

    const term = makeTerm();
    const fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    term.open(wrap);
    terms[id] = term;
    fits[id] = fitAddon;

    // GPU-accelerated rendering: WebGL -> Canvas -> DOM fallback
    try {
      const webgl = new WebglAddon.WebglAddon();
      // T11: the addon's event is onContextLoss. The old onContextLost call
      // threw a TypeError here, so WebGL never engaged and every client ran
      // on Canvas. Canvas remains the fallback on a real context loss.
      webgl.onContextLoss(() => {
        webgl.dispose();
        try { term.loadAddon(new CanvasAddon.CanvasAddon()); } catch (e2) { console.warn('Canvas fallback failed:', e2.message); }
      });
      term.loadAddon(webgl);
    } catch (e) {
      console.warn('WebGL failed:', e.message);
      try { term.loadAddon(new CanvasAddon.CanvasAddon()); } catch (e2) { console.warn('Canvas failed:', e2.message); }
    }

    // Single fit after layout settles
    setTimeout(() => {
      try {
        fitAddon.fit();
        const dims = fitAddon.proposeDimensions();
        if (dims && ws && ws.readyState === 1) {
          lastCols = dims.cols;
          lastRows = dims.rows;
          queueSend({ type: 'resize', cols: dims.cols, rows: dims.rows });
          updateDiag(dims.cols, dims.rows);
        }
      } catch (e) { clientLog('fit failed: ' + e.message); }
    }, 150);
    wrap.addEventListener('touchstart', e => { e.stopPropagation(); e.preventDefault(); }, true);
    wrap.addEventListener('touchmove', e => { e.stopPropagation(); e.preventDefault(); }, true);
  }

  const wrap = document.getElementById(`tw-${id}`);
  if (wrap) {
    wrap.classList.add('active');
    if (RENDERER_MODE !== 'grid') {
      setTimeout(() => { try { fits[id]?.fit(); } catch (e) { clientLog('switchTo fit: ' + e.message); } }, 50);
    } else {
      // T19: emit an initial resize once the grid wrap has layout, so the
      // server knows the viewport size before producing a snapshot. The
      // 50ms call may probe before SF Mono/Menlo has resolved (iOS Safari
      // briefly uses a fallback whose char metrics differ from the final
      // monospace, leading to wrong cols). Schedule a second pass once
      // fonts.ready resolves, which corrects to the real char width.
      setTimeout(() => doResize(), 50);
      if (document.fonts && document.fonts.ready) {
        // T11: metrics are cached now, so drop what the first pass measured.
        document.fonts.ready.then(() => remeasureGrids());
      }
    }
  }

  emptyState.style.display = 'none';
  if (ws && ws.readyState === 1) queueSend({ type: 'connect', session: id, renderer: RENDERER_MODE });
  updateHdr(); renderTabs();
  syncFocusReport();   // T08: out for the session left, in for this one
}

function closeSession(id) {
  const s = sessionList.find(x => x.id === id);
  if (!confirm(`Close ${s ? s.name : 'session'}?`)) return;
  if (terms[id]) { terms[id].dispose(); delete terms[id]; delete fits[id]; }
  if (gridTerms[id]) { delete gridTerms[id]; }
  const w = document.getElementById(`tw-${id}`);
  if (w) w.remove();
  queueSend({ type: 'close', session: id });
  if (activeSession === id) {
    activeSession = null;
    const rest = sessionList.filter(x => x.id !== id);
    if (rest.length) switchTo(rest[0].id); else { emptyState.style.display = 'flex'; updateHdr(); }
  }
}

function updateHdr() {
  const s = sessionList.find(x => x.id === activeSession);
  if (!document.activeElement || document.activeElement !== sname) {
    sname.value = s ? s.name.toUpperCase() : 'NO SESSION';
  }
  sdir.textContent = s ? shortDir(s.dir) : '';
  sdir.title = s ? s.dir : '';
  sname.disabled = !s;
}

function commitRename() {
  if (activeSession === null) return;
  const name = sname.value.trim().toUpperCase();
  if (!name) return;
  sname.value = name;
  const s = sessionList.find(x => x.id === activeSession);
  if (s && name !== s.name) {
    s.name = name;
    queueSend({ type: 'rename', session: activeSession, name });
    renderTabs();
  }
}

// T04a: was onfocus="this.select()" onblur="commitRename()"
// onkeydown="if(event.key==='Enter'){this.blur()}" on #sname. `this` in those
// attributes was the input itself, which is the `sname` binding here.
sname.addEventListener('focus', () => sname.select());
sname.addEventListener('blur', () => commitRename());
sname.addEventListener('keydown', e => { if (e.key === 'Enter') sname.blur(); });

// ── T13: layout mode ─────────────────────────────────────────────
// One source of truth for "is this a tablet-or-wider viewport", shared by
// the side pane below, the swipe gating (T15) and the keyboard/font defaults
// (T12/T14). The bounds are the ones in style.css's tablet media queries (see
// the comment there for why portrait starts lower): 820px wide in any
// orientation, or 600px wide in portrait. test/ipad-webkit.py fails if these
// queries and the CSS ever disagree. Kept as matchMedia objects rather than
// an innerWidth read so the transition fires an event -- an iPad rotating
// portrait->landscape crosses the boundary without a reload.
const TABLET_MIN_PX = 820;
const TABLET_PORTRAIT_MIN_PX = 600;
// Portrait tablet: the side pane is a modal slide-over (T07).
const PANE_MODAL_QUERY = `(min-width: ${TABLET_PORTRAIT_MIN_PX}px) and (orientation: portrait)`;
const WIDE_LAYOUT_QUERY = `(min-width: ${TABLET_MIN_PX}px), ${PANE_MODAL_QUERY}`;
const wideMQ = window.matchMedia(WIDE_LAYOUT_QUERY);

function isWideLayout() { return wideMQ.matches; }

function onLayoutChange() {
  document.body.classList.toggle('wide', isWideLayout());
  applyHwKeyboard();    // T12: the default (on for tablets) tracks the boundary
  applyFontSize();      // T14: so does the default font size
  syncSwipeHandlers();  // T15: swipe nav is bound only at narrow widths
  if (isWideLayout()) closeSwitcher();  // T07: the phone overlay has no place here
  renderTabs();
}

wideMQ.addEventListener('change', onLayoutChange);
document.body.classList.toggle('wide', isWideLayout());

function renderTabs() {
  const pill = $('tab-pill');
  const pillName = pill.querySelector('.pill-name');
  const pillDir = pill.querySelector('.pill-dir');
  const countBtn = $('tab-count-btn');
  const s = sessionList.find(x => x.id === activeSession);

  // Update pill content
  pillName.textContent = s ? s.name : 'No session';
  pillDir.textContent = s ? s.dir.split('\\').pop() : '';

  // Update count text
  countBtn.querySelector('.count-text').textContent = sessionList.length || '0';

  // Notification: red dot on pill + badge on count when ANY session needs input
  const anyAttn = sessionList.some(x => x.attention);
  pill.classList.toggle('needs-input', anyAttn);
  countBtn.classList.toggle('has-attn', anyAttn);

  // Update switcher if open (phone), and the side pane (tablet, T07)
  renderSwitcher();
  renderSidepane();
}

function toggleSwitcher() {
  const sw = $('tab-switcher');
  sw.classList.toggle('open');
  if (sw.classList.contains('open')) renderSwitcher();
}

function closeSwitcher() {
  $('tab-switcher').classList.remove('open');
}

// T04a: #tab-pill carried onclick="scrollBottom()" and #tab-count-btn
// onclick="toggleSwitcher()". The count button also has touch handlers of its
// own (pull-up = new session, further down); those are untouched -- this is
// only the tap.
$('tab-pill').addEventListener('click', () => scrollBottom());
$('tab-count-btn').addEventListener('click', () => toggleSwitcher());

// The PHONE switcher overlay only. In the tablet layout the sessions live in the side
// pane (T07, renderSidepane below), which is keyed and diffed; this overlay is
// rebuilt only while it is open on a phone, where it is small and transient.
function renderSwitcher() {
  const sw = $('tab-switcher');
  if (isWideLayout() || !sw.classList.contains('open')) return;
  sw.innerHTML = '';
  sessionList.forEach(s => {
    const item = document.createElement('div');
    item.className = 'switcher-item' + (s.id === activeSession ? ' active' : '');
    // Attention dot
    if (s.attention) {
      const attn = document.createElement('span');
      attn.className = 'sw-attn';
      item.appendChild(attn);
    }
    // Name
    const name = document.createElement('span');
    name.className = 'sw-name';
    name.textContent = s.name;
    item.appendChild(name);
    // Close button
    const close = document.createElement('button');
    close.className = 'sw-close';
    close.textContent = 'x';
    close.onclick = (e) => { e.stopPropagation(); closeSession(s.id); };
    item.appendChild(close);
    // Tap to switch
    item.onclick = () => { switchTo(s.id); closeSwitcher(); };
    sw.appendChild(item);
  });
  if (!sessionList.length) {
    const empty = document.createElement('div');
    empty.className = 'switcher-item';
    empty.style.color = 'var(--dim)';
    empty.style.justifyContent = 'center';
    empty.textContent = 'No sessions';
    sw.appendChild(empty);
  }
}

// -- T07: sessions side pane (herdr's Agents list) --------------------
// One row per session: state glyph, name, cwd basename (+ worktree), and the
// agent's terminal title. Status is herdr's (D7, session.agent from T06);
// sessions without a feed (dtach) fall back to the server's attention, and
// with neither the state is 'unknown' -- never a guessed idle.
//
// Rows are keyed by session id and PATCHED: an existing row's nodes are
// reused, only changed text/attributes are written, and a reorder moves only
// the rows outside the longest already-ordered run. No innerHTML anywhere.
//
// Hooks for T08 (shortcuts): selectSession(id), nextNeedsAttention(),
// openSidepane()/closeSidepane()/toggleSidepane().
const SP_SORT_KEY = 'cm-sidepane-sort';
const SP_RANK = { blocked: 0, done: 1, working: 2, idle: 3, unknown: 4 };
const SP_STATUS_TEXT = {
  blocked: 'Needs input', done: 'Done, not yet viewed', working: 'Working',
  idle: 'Idle', unknown: 'Status unknown',
};
const SVG_NS = 'http://www.w3.org/2000/svg';
const sidepane = $('sidepane'), spList = $('sp-list'), spScrim = $('sp-scrim');
const spToggle = $('sp-toggle'), spSortBtn = $('sp-sort');
const spRows = new Map();   // session id -> row record (DOM nodes + last written values)
const paneModalMQ = window.matchMedia(PANE_MODAL_QUERY);

function readSidepaneSort() {
  try { return localStorage.getItem(SP_SORT_KEY) === 'manual' ? 'manual' : 'priority'; }
  catch (e) { return 'priority'; }   // storage blocked: the default, not an error
}
let spSort = readSidepaneSort();

function setSidepaneSort(mode) {
  spSort = mode === 'manual' ? 'manual' : 'priority';
  try { localStorage.setItem(SP_SORT_KEY, spSort); } catch (e) { /* not persisted; still applied */ }
  renderSidepane();
}

function sessionStatus(s) {
  const st = s.agent && s.agent.status;
  if (Object.prototype.hasOwnProperty.call(SP_RANK, st)) return st;
  if (s.agent) return 'unknown';
  if (s.attention === 'permission' || s.attention === 'question') return 'blocked';
  if (s.attention === 'ready') return 'done';
  return 'unknown';
}

// Priority = herdr's attention queue: blocked, done, working, idle, unknown;
// ties keep the server's order (a stable sort on the original index).
function prioritySorted(list) {
  return list.map((s, i) => [s, i])
    .sort((a, b) => (SP_RANK[sessionStatus(a[0])] - SP_RANK[sessionStatus(b[0])]) || (a[1] - b[1]))
    .map(x => x[0]);
}

function sidepaneOrder(list) {
  return spSort === 'priority' ? prioritySorted(list) : list.slice();
}

function baseName(p) {
  if (!p) return '';
  const parts = String(p).split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : String(p);
}

// Worktree label: a linked worktree's checkout name, else the repo name --
// the first that says something the cwd folder does not. herdr reports no
// branch, so none is shown.
function worktreeLabel(wt, cwdBase) {
  if (!wt) return '';
  const names = [wt.linked && wt.path ? baseName(wt.path) : '', wt.repo || ''];
  return names.find(n => n && n !== cwdBase) || '';
}

function svgUse(href) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', href);
  svg.appendChild(use);
  return { svg, use };
}

function spText(el, v) { if (el.textContent !== v) el.textContent = v; }
function spAttr(el, name, v) {
  if (v === null || v === undefined) { if (el.hasAttribute(name)) el.removeAttribute(name); }
  else if (el.getAttribute(name) !== v) el.setAttribute(name, v);
}

function makeSidepaneRow(id) {
  const li = document.createElement('li');
  li.className = 'sp-row';
  li.dataset.id = String(id);
  const main = document.createElement('button');
  main.type = 'button';
  main.className = 'sp-main';
  const state = document.createElement('span');
  state.className = 'sp-state';
  const glyph = svgUse('#s-unknown');
  state.appendChild(glyph.svg);
  const unseen = document.createElement('span');
  unseen.className = 'sp-unseen';
  state.appendChild(unseen);
  const text = document.createElement('span');
  text.className = 'sp-text';
  const name = document.createElement('span');
  name.className = 'sp-name';
  const meta = document.createElement('span');
  meta.className = 'sp-meta';
  const cwd = document.createElement('span');
  cwd.className = 'sp-cwd';
  const wt = document.createElement('span');
  wt.className = 'sp-wt';
  wt.hidden = true;
  wt.appendChild(svgUse('#i-branch').svg);
  const wtText = document.createElement('span');
  wt.appendChild(wtText);
  meta.append(cwd, wt);
  const title = document.createElement('span');
  title.className = 'sp-title';
  text.append(name, meta, title);
  main.append(state, text);
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'sp-close';
  close.appendChild(svgUse('#i-xmark').svg);
  li.append(main, close);
  main.addEventListener('click', () => selectSession(id));
  close.addEventListener('click', e => { e.stopPropagation(); closeSession(id); });
  return { li, main, use: glyph.use, name, cwd, wt, wtText, title, close };
}

function updateSidepaneRow(r, s) {
  const status = sessionStatus(s);
  const a = s.agent || null;
  const cwdBase = baseName((a && a.cwd) || s.dir);
  const wt = worktreeLabel(a && a.worktree, cwdBase);
  const title = (a && (a.title || a.agent)) || '';
  const active = s.id === activeSession;
  spAttr(r.li, 'data-status', status);
  spAttr(r.use, 'href', '#s-' + status);
  r.li.classList.toggle('active', active);
  spAttr(r.main, 'aria-current', active ? 'true' : null);
  spText(r.name, s.name);
  spText(r.cwd, cwdBase);
  spText(r.wtText, wt);
  if (r.wt.hidden !== !wt) r.wt.hidden = !wt;
  spText(r.title, title);
  spAttr(r.main, 'aria-label', s.name + ', ' + SP_STATUS_TEXT[status]
    + (cwdBase ? ', in ' + cwdBase : '') + (wt ? ', worktree ' + wt : '')
    + (title ? ', ' + title : '') + (active ? ', current' : ''));
  spAttr(r.close, 'aria-label', 'Close ' + s.name);
}

// Longest increasing subsequence of `seq` (indices into seq): the rows that
// are already in the right relative order and need not move.
function lisIndices(seq) {
  const tails = [], prev = new Array(seq.length);
  for (let i = 0; i < seq.length; i++) {
    let lo = 0, hi = tails.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (seq[tails[m]] < seq[i]) lo = m + 1; else hi = m; }
    prev[i] = lo > 0 ? tails[lo - 1] : -1;
    tails[lo] = i;
  }
  const keep = new Set();
  for (let k = tails.length ? tails[tails.length - 1] : -1; k >= 0; k = prev[k]) keep.add(k);
  return keep;
}

function renderSidepane() {
  const order = sidepaneOrder(sessionList);
  const wanted = new Set(order.map(s => s.id));
  for (const [id, r] of spRows) {
    if (!wanted.has(id)) { r.li.remove(); spRows.delete(id); }
  }
  const domPos = new Map();
  [...spList.children].forEach((el, i) => domPos.set(el, i));
  const rows = order.map(s => {
    let r = spRows.get(s.id);
    if (!r) { r = makeSidepaneRow(s.id); spRows.set(s.id, r); }
    updateSidepaneRow(r, s);
    return r;
  });
  // Only rows already in the list can stay put; new ones get position -1.
  const seq = rows.map(r => (domPos.has(r.li) ? domPos.get(r.li) : -1));
  const placed = rows.map((r, i) => i).filter(i => seq[i] >= 0);
  const keepIdx = lisIndices(placed.map(i => seq[i]));
  const keep = new Set([...keepIdx].map(k => placed[k]));
  for (let i = rows.length - 1; i >= 0; i--) {
    if (keep.has(i)) continue;
    const next = i + 1 < rows.length ? rows[i + 1].li : null;
    spList.insertBefore(rows[i].li, next);
  }
  const empty = $('sp-empty');
  if (empty.hidden !== order.length > 0) empty.hidden = order.length > 0;
  const manual = spSort === 'manual';
  spText($('sp-sort-val'), manual ? 'Manual' : 'Priority');
  spAttr(spSortBtn, 'aria-label', manual ? 'Sort: manual order. Switch to priority'
                                         : 'Sort: priority. Switch to manual order');
}

// Pick a session from the pane (or, later, a shortcut). Closes the portrait
// sheet and hands keyboard focus back to the terminal.
function selectSession(id) {
  if (!sessionList.some(s => s.id === id)) return false;
  const ae = document.activeElement;
  if (ae && ae !== document.body && sidepane.contains(ae)) ae.blur();
  if (sidepaneOpen()) {
    // Start the slide-out before the switch: mounting a session is main-
    // thread work, and the transition cannot begin until a frame commits.
    closeSidepane();
    requestAnimationFrame(() => setTimeout(() => { if (id !== activeSession) switchTo(id); }, 0));
    return true;
  }
  if (id !== activeSession) switchTo(id);
  return true;
}

// The next session needing the operator (blocked, then an unseen finish),
// cycling from the active one. Returns false when nothing needs attention.
function nextNeedsAttention() {
  const queue = prioritySorted(sessionList).filter(s => {
    const st = sessionStatus(s);
    return st === 'blocked' || st === 'done';
  });
  if (!queue.length) return false;
  const i = queue.findIndex(s => s.id === activeSession);
  const next = queue[(i + 1) % queue.length];
  return next.id === activeSession ? false : selectSession(next.id);
}

// Portrait: the pane is a modal slide-over. Landscape: pinned, never "open".
function sidepaneIsModal() { return paneModalMQ.matches; }
function sidepaneOpen() { return sidepane.classList.contains('open'); }

function openSidepane() {
  if (!sidepaneIsModal() || sidepaneOpen()) return;
  closeSettings();
  renderSidepane();
  sidepane.classList.add('open');
  spScrim.classList.add('open');
  spToggle.setAttribute('aria-expanded', 'true');
  spToggle.setAttribute('aria-label', 'Hide sessions');
  // Focus the sheet itself (tabindex -1, no ring): screen readers land in it,
  // and the next Tab reaches the rows.
  try { sidepane.focus({ preventScroll: true }); } catch (e) { /* focus is best-effort */ }
}

function closeSidepane() {
  if (!sidepaneOpen()) return;
  const hadFocus = sidepane.contains(document.activeElement);
  sidepane.classList.remove('open');
  spScrim.classList.remove('open');
  spToggle.setAttribute('aria-expanded', 'false');
  spToggle.setAttribute('aria-label', 'Show sessions');
  if (hadFocus) document.activeElement.blur();
}

function toggleSidepane() { sidepaneOpen() ? closeSidepane() : openSidepane(); }

function syncSidepaneMode() {
  if (!sidepaneIsModal()) closeSidepane();
  renderSidepane();
}
paneModalMQ.addEventListener('change', syncSidepaneMode);

spToggle.addEventListener('click', e => { e.preventDefault(); toggleSidepane(); });
spScrim.addEventListener('click', () => closeSidepane());
spSortBtn.addEventListener('click', () => setSidepaneSort(spSort === 'priority' ? 'manual' : 'priority'));
$('new-btn').addEventListener('click', () => { closeSidepane(); newSession(); });

// Swipe in from the left edge opens the portrait sheet; a leftward swipe on
// the open sheet closes it. Passive listeners: they never block a scroll.
const SP_EDGE_PX = 24, SP_SWIPE_PX = 48;
let spSwipe = null;
document.addEventListener('touchstart', e => {
  spSwipe = null;
  if (!sidepaneIsModal() || e.touches.length !== 1) return;
  const t = e.touches[0];
  if (!sidepaneOpen() && t.clientX <= SP_EDGE_PX) spSwipe = { x: t.clientX, y: t.clientY, opening: true };
  else if (sidepaneOpen() && e.target.closest && e.target.closest('#sidepane')) {
    spSwipe = { x: t.clientX, y: t.clientY, opening: false };
  }
}, { passive: true });
document.addEventListener('touchmove', e => {
  if (!spSwipe || e.touches.length !== 1) return;
  const t = e.touches[0];
  const dx = t.clientX - spSwipe.x, dy = t.clientY - spSwipe.y;
  if (Math.abs(dy) > 12 && Math.abs(dy) > Math.abs(dx)) { spSwipe = null; return; }
  if (spSwipe.opening && dx > SP_SWIPE_PX) { spSwipe = null; openSidepane(); }
  else if (!spSwipe.opening && dx < -SP_SWIPE_PX) { spSwipe = null; closeSidepane(); }
}, { passive: true });
document.addEventListener('touchend', () => { spSwipe = null; }, { passive: true });
document.addEventListener('touchcancel', () => { spSwipe = null; }, { passive: true });

function newSession() {
  if (!ws || ws.readyState !== 1) return;
  const num = sessionList.length + 1;
  const defaultDir = (projects && projects.length) ? projects[0].dir : '';
  // Send screen dimensions so the new session starts at this client's width.
  // T14: measure the cell instead of assuming 7.8px -- that constant was the
  // char width at 13px SF Mono only, and the font size is now a setting, so
  // it over-reported columns by ~23% at 16px.
  const live = activeSession !== null ? computeGridDims(gridTerms[activeSession]) : null;
  let cols = live ? live.cols : 50;
  if (!live) {
    const probeWrap = document.createElement('div');
    probeWrap.className = 'grid-term';
    probeWrap.style.cssText = 'position:absolute;visibility:hidden;width:100%;height:0';
    termArea.appendChild(probeWrap);
    const cell = probeCell(probeWrap);
    termArea.removeChild(probeWrap);
    if (cell.w > 0) cols = Math.max(10, Math.floor((termArea.clientWidth || 320) / cell.w));
  }
  const rows = 200;
  queueSend({ type: 'create', name: 'SESSION ' + num, dir: defaultDir, cols, rows });
}

// T04a: was onclick="newSession()" on #empty-state.
emptyState.addEventListener('click', () => newSession());

// ── Safari-style Gesture Navigation (with slide animation) ──
const SWIPE_THRESHOLD = 80;
const NEW_SESSION_THRESHOLD = 150;
const SWIPE_ANIM_MS = 280;
let swipeStartX = 0, swipeStartY = 0, swiping = false, swipeDx = 0;
const hintL = $('swipe-hint-left');
const hintR = $('swipe-hint-right');
const newHint = $('new-session-hint');
let swipePeekWrap = null; // the term-wrap being peeked during swipe

function getActiveIndex() {
  return sessionList.findIndex(s => s.id === activeSession);
}

// Close switcher when tapping outside
document.addEventListener('click', e => {
  const sw = $('tab-switcher');
  if (!sw.classList.contains('open')) return;
  if (!e.target.closest('#tabs')) closeSwitcher();
});

function navigateTab(direction) {
  closeSwitcher();
  const idx = getActiveIndex();
  if (idx < 0) return false;
  const target = idx + direction;
  if (target >= 0 && target < sessionList.length) {
    switchTo(sessionList[target].id);
    return true;
  }
  return false;
}

// Animated slide transition between sessionList entries
function animatedSwitchTo(targetId, direction) {
  // direction: -1 = sliding right (prev session), +1 = sliding left (next session)
  const currentWrap = activeSession !== null ? document.getElementById(`tw-${activeSession}`) : null;
  const vw = window.innerWidth;

  // Switch session (creates wrap if needed)
  switchTo(targetId);
  const targetWrap = document.getElementById(`tw-${targetId}`);
  if (!targetWrap) return;

  // Position target off-screen, make both visible
  targetWrap.style.transform = `translateX(${direction * vw}px)`;
  targetWrap.classList.add('swipe-visible');
  if (currentWrap && currentWrap !== targetWrap) {
    currentWrap.classList.add('swipe-visible');
    currentWrap.style.transform = 'translateX(0)';
  }

  // Force layout before adding transition class
  targetWrap.offsetWidth;

  // Animate both
  targetWrap.classList.add('swipe-animate');
  targetWrap.style.transform = 'translateX(0)';
  if (currentWrap && currentWrap !== targetWrap) {
    currentWrap.classList.add('swipe-animate');
    currentWrap.style.transform = `translateX(${-direction * vw}px)`;
  }

  // Cleanup after animation
  setTimeout(() => {
    targetWrap.classList.remove('swipe-animate', 'swipe-visible');
    targetWrap.style.transform = '';
    if (currentWrap && currentWrap !== targetWrap) {
      currentWrap.classList.remove('swipe-animate', 'swipe-visible', 'active');
      currentWrap.style.transform = '';
      currentWrap.style.display = '';
    }
  }, SWIPE_ANIM_MS + 20);
}

// Gesture navigation -- attached to document, filtered by touch origin
// Using document-level avoids iOS event bubbling issues with nested elements
let swipeActive = false;

function onSwipeStart(e) {
  if (e.touches.length !== 1) return;
  const t = e.touches[0];
  // Only activate for touches inside the terminal area
  const ta = $('term-area');
  const rect = ta.getBoundingClientRect();
  if (t.clientY < rect.top || t.clientY > rect.bottom || t.clientX < rect.left || t.clientX > rect.right) return;
  swipeActive = true;
  swipeStartX = t.clientX;
  swipeStartY = t.clientY;
  swiping = false;
  swipeDx = 0;
  swipePeekWrap = null;
}

function onSwipeMove(e) {
  if (!swipeActive || e.touches.length !== 1) return;
  const t = e.touches[0];
  const dx = t.clientX - swipeStartX;
  const dy = t.clientY - swipeStartY;
  // Lock to horizontal after 10px movement
  if (!swiping && Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy) * 1.5) {
    swiping = true;
  }
  if (!swiping) return;
  swipeDx = dx;
  const idx = getActiveIndex();
  const vw = window.innerWidth;
  const activeWrap = activeSession !== null ? document.getElementById(`tw-${activeSession}`) : null;

  // Show edge hints
  hintL.classList.toggle('flash', dx > 20 && idx > 0);
  hintR.classList.toggle('flash', dx < -20 && idx < sessionList.length - 1);

  // Translate active terminal following finger (damped at edges)
  if (activeWrap) {
    const canGoLeft = idx > 0;
    const canGoRight = idx < sessionList.length - 1;
    let clampedDx = dx;
    // Rubber-band at edges (no session in that direction)
    if ((!canGoLeft && dx > 0) || (!canGoRight && dx < 0 && idx === sessionList.length - 1 && Math.abs(dx) < NEW_SESSION_THRESHOLD * 0.5)) {
      clampedDx = dx * 0.3;
    }
    activeWrap.style.transform = `translateX(${clampedDx}px)`;

    // Show peek of target session
    const peekDir = dx > 0 ? -1 : 1; // -1=prev, 1=next
    const peekIdx = idx + peekDir;
    const peekSession = (peekIdx >= 0 && peekIdx < sessionList.length) ? sessionList[peekIdx] : null;

    // Clean up old peek if direction changed
    if (swipePeekWrap && peekSession && swipePeekWrap.id !== `tw-${peekSession.id}`) {
      swipePeekWrap.classList.remove('swipe-visible');
      swipePeekWrap.style.transform = '';
      swipePeekWrap = null;
    }

    if (peekSession) {
      let peekEl = document.getElementById(`tw-${peekSession.id}`);
      if (peekEl) {
        peekEl.classList.add('swipe-visible');
        peekEl.style.transform = `translateX(${peekDir * vw + clampedDx}px)`;
        swipePeekWrap = peekEl;
      }
    }
  }

  // New session pull indicator (swipe left past last tab)
  if (dx < -20 && idx === sessionList.length - 1) {
    const pull = Math.min(Math.abs(dx), 200);
    // T09: revealed by transform (compositor only), never by width. The
    // hint is 200px wide and rests at translateX(100%), off the right edge.
    newHint.style.transform = `translateX(${200 - pull}px)`;
    newHint.classList.toggle('ready', pull >= NEW_SESSION_THRESHOLD);
  } else {
    newHint.style.transform = '';
    newHint.classList.remove('ready');
  }
}

function endSwipe() {
  hintL.classList.remove('flash');
  hintR.classList.remove('flash');
  newHint.style.transform = '';
  newHint.classList.remove('ready');
  if (!swipeActive) return;
  swipeActive = false;

  const activeWrap = activeSession !== null ? document.getElementById(`tw-${activeSession}`) : null;
  const idx = getActiveIndex();
  const vw = window.innerWidth;
  const committed = Math.abs(swipeDx) > SWIPE_THRESHOLD;
  const isNewSession = idx === sessionList.length - 1 && swipeDx < -NEW_SESSION_THRESHOLD;

  if (!swiping) {
    // No swipe detected -- clean up any transforms
    if (activeWrap) activeWrap.style.transform = '';
    if (swipePeekWrap) { swipePeekWrap.classList.remove('swipe-visible'); swipePeekWrap.style.transform = ''; }
    swipePeekWrap = null;
    return;
  }

  if (committed && !isNewSession) {
    // Animate to completion
    const direction = swipeDx > 0 ? -1 : 1; // which way are we navigating
    const targetIdx = idx + direction;
    if (targetIdx >= 0 && targetIdx < sessionList.length) {
      const targetId = sessionList[targetIdx].id;

      // Animate current out
      if (activeWrap) {
        activeWrap.classList.add('swipe-animate');
        activeWrap.style.transform = `translateX(${-direction * vw}px)`;
      }
      // Animate peek in
      if (swipePeekWrap) {
        swipePeekWrap.classList.add('swipe-animate');
        swipePeekWrap.style.transform = 'translateX(0)';
      }

      setTimeout(() => {
        // Clean up animation classes + transforms
        if (activeWrap) {
          activeWrap.classList.remove('swipe-animate', 'active');
          activeWrap.style.transform = '';
          activeWrap.style.display = '';
        }
        if (swipePeekWrap) {
          swipePeekWrap.classList.remove('swipe-animate', 'swipe-visible');
          swipePeekWrap.style.transform = '';
        }
        swipePeekWrap = null;
        // Actually switch session state (no visual change -- already in position)
        switchTo(targetId);
      }, SWIPE_ANIM_MS + 20);
    } else {
      snapBack(activeWrap);
    }
  } else if (isNewSession) {
    // Snap back then create new session (it will animate in via switchTo)
    snapBack(activeWrap);
    newSession();
  } else {
    // Snap back to original position
    snapBack(activeWrap);
  }

  swiping = false;
  swipeDx = 0;
}

function snapBack(activeWrap) {
  if (activeWrap) {
    activeWrap.classList.add('swipe-animate');
    activeWrap.style.transform = 'translateX(0)';
    setTimeout(() => {
      activeWrap.classList.remove('swipe-animate');
      activeWrap.style.transform = '';
    }, SWIPE_ANIM_MS + 20);
  }
  if (swipePeekWrap) {
    const vw = window.innerWidth;
    const peekDir = swipeDx > 0 ? -1 : 1;
    swipePeekWrap.classList.add('swipe-animate');
    swipePeekWrap.style.transform = `translateX(${peekDir * vw}px)`;
    setTimeout(() => {
      swipePeekWrap.classList.remove('swipe-animate', 'swipe-visible');
      swipePeekWrap.style.transform = '';
      swipePeekWrap = null;
    }, SWIPE_ANIM_MS + 20);
  } else {
    swipePeekWrap = null;
  }
}

// ── T15: swipe navigation is a narrow-width behaviour ────────────────
// Finger-following session switching exists because a 390px screen shows
// exactly one session, so the only way between them is a gesture. On an
// iPad the persistent tab strip (T13) shows every session at once, the
// keyboard has Cmd-Shift-arrows (T12), and a horizontal drag from near the
// edge is an iPadOS system gesture -- so here the swipe earns little and
// competes with the OS. The handlers are genuinely bound/unbound rather
// than early-returning: a bound document-level touchmove listener still
// costs iOS a hit-test on every frame of a system gesture.
//
// The code stays. A phone is still a supported client, and rotating an
// iPad or resizing a desktop window across the tablet bound re-binds it live.
let swipeHandlersBound = false;

function swipeNavigationActive() { return swipeHandlersBound; }

function bindSwipeHandlers() {
  if (swipeHandlersBound) return;
  document.addEventListener('touchstart', onSwipeStart, { passive: true });
  document.addEventListener('touchmove', onSwipeMove, { passive: true });
  document.addEventListener('touchend', endSwipe, { passive: true });
  document.addEventListener('touchcancel', endSwipe, { passive: true });
  swipeHandlersBound = true;
}

function unbindSwipeHandlers() {
  if (!swipeHandlersBound) return;
  document.removeEventListener('touchstart', onSwipeStart);
  document.removeEventListener('touchmove', onSwipeMove);
  document.removeEventListener('touchend', endSwipe);
  document.removeEventListener('touchcancel', endSwipe);
  swipeHandlersBound = false;
  // Abandon any gesture that was mid-flight when the boundary was crossed.
  // swipeDx is zeroed first so endSwipe snaps back instead of committing a
  // session switch the user never finished asking for.
  if (swipeActive || swiping) { swipeDx = 0; endSwipe(); }
  swipeActive = false;
  swiping = false;
  swipeDx = 0;
}

function syncSwipeHandlers() {
  if (isWideLayout()) unbindSwipeHandlers(); else bindSwipeHandlers();
}

syncSwipeHandlers();

let lastSent = '';

function clearPrompt() {
  qsend('\x1b[F');
  setTimeout(() => { qsend('\x7f'.repeat(500)); }, 30);
}

function sendMsg() {
  let t = msgInput.value;
  if (activeSession === null) return;
  if (!t && !pendingImage) { qsend('\r'); return; }
  // Prepend image path if attached
  if (pendingImage) {
    t = (t ? t + ' ' : 'Look at this screenshot: ') + pendingImage;
    pendingImage = null;
    imgPreview.classList.remove('show');
    imgBtn.classList.remove('has-img');
  }
  lastSent = t;
  clearPrompt();
  setTimeout(() => {
    qsend(t + '\r');
  }, 80);
  msgInput.value = '';
  autoGrow();
  updateSendBtn();
  userScrolled = false; // auto-follow new output after sending
  msgInput.classList.add('sent');
  setTimeout(() => { msgInput.classList.remove('sent'); }, 300);
}

function editLast() {
  if (!lastSent) return;
  msgInput.value = lastSent;
  autoGrow();
  updateSendBtn();
  msgInput.focus();
  clearPrompt();
}

// ── Image Upload ──
let pendingImage = null;
const imgInput = $('img-input');
const imgPreview = $('img-preview');
const imgName = $('img-name');
const imgClear = $('img-clear');
const imgBtn = $('img-btn');

// Direct click handler as fallback for iOS (label-for can fail with hidden inputs)
imgBtn.addEventListener('click', (e) => {
  e.preventDefault();
  imgInput.click();
});

imgInput.addEventListener('change', async () => {
  const file = imgInput.files[0];
  if (!file) return;
  imgBtn.classList.remove('err');
  imgBtn.classList.add('busy');
  imgBtn.setAttribute('aria-busy', 'true');
  try {
    const res = await fetch('/api/upload', {
      method: 'POST',
      headers: { 'Content-Type': file.type || 'image/png', 'X-Session-Token': sessionToken },
      body: file
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(err);
    }
    const data = await res.json();
    pendingImage = data.path;
    imgName.textContent = data.filename;
    imgPreview.classList.add('show');
    imgBtn.classList.add('has-img');
  } catch (e) {
    console.error('Upload failed:', e);
    showStatus('Upload failed: ' + (e.message || 'unknown error'), 'var(--intent-danger-text)');
    imgBtn.classList.add('err');
    setTimeout(() => { imgBtn.classList.remove('err'); }, 3000);
  }
  imgBtn.classList.remove('busy');
  imgBtn.removeAttribute('aria-busy');
  imgInput.value = '';
});

imgClear.addEventListener('click', () => {
  pendingImage = null;
  imgPreview.classList.remove('show');
  imgBtn.classList.remove('has-img');
});

function updateSendBtn() {
  // T09: the button is a glyph (return when empty, arrow.up with text); the
  // accessible name carries what the old text label said.
  const has = !!msgInput.value.trim();
  const btn = $('send');
  btn.classList.toggle('has-text', has);
  btn.setAttribute('aria-label', has ? 'Send message' : 'Send Enter');
}

let lastMsgHeight = 0;
function autoGrow() {
  // T14: while the compose box is collapsed (hardware-keyboard mode, not
  // focused) it is sized by CSS. An inline height from here would win the
  // cascade and re-expand it after every send.
  if (document.body.classList.contains('hwkb') && document.activeElement !== msgInput) {
    msgInput.style.height = '';
    lastMsgHeight = -1;
    return;
  }
  // Only measure if content changed length (avoid unnecessary reflows)
  const len = msgInput.value.length;
  if (len === lastMsgHeight) return;
  lastMsgHeight = len;
  msgInput.style.height = '0';
  // CSS max-height caps it per layout (64px phone, 132px tablet).
  msgInput.style.height = Math.min(msgInput.scrollHeight, 132) + 'px';
}

function qsend(k) {
  if (!ws || ws.readyState !== 1 || activeSession === null) return;
  queueSend({ type: 'input', data: k });
}

// ── Quick-action bar (T04a: moved off inline on* attributes) ──
// Three separate concerns used to live in the markup, and all three are
// load-bearing:
//
//   1. #qbar onmousedown -> preventDefault, unconditionally. A mousedown
//      default action moves focus, which would blur the compose box; the
//      button still gets its click because preventDefault on mousedown does
//      not cancel the click.
//   2. #qbar ontouchstart -> preventDefault ONLY when the touch missed a
//      button. Same blur protection for the bar background, but a touch that
//      landed on a .qb must run its course so the button's own touchend
//      handler below fires. Cancelling it at touchstart would kill the press.
//   3. .qb ontouchend -> preventDefault + action, PLUS onclick -> action.
//      The pair is the iOS double-fire guard: preventDefault on touchend
//      suppresses the compatibility click the browser would synthesise, so a
//      tap runs the action once via touchend and a mouse click runs it once
//      via click. Same shape as the send button.
//
// preventDefault needs { passive: false } explicitly here -- these are added
// with addEventListener rather than parsed as attributes, and touch listeners
// are the ones browsers make passive by default.
const QUICK_ACTIONS = {
  clear: () => clearPrompt(),
  edit: () => editLast(),
  esc: () => qsend('\x1b'),
  up: () => qsend('\x1b[A'),
  down: () => qsend('\x1b[B'),
};

const qbarEl = $('qbar');
qbarEl.addEventListener('mousedown', e => e.preventDefault(), { passive: false });
qbarEl.addEventListener('touchstart', e => {
  if (!e.target.closest('.qb')) e.preventDefault();
}, { passive: false });

qbarEl.querySelectorAll('.qb').forEach(btn => {
  const run = QUICK_ACTIONS[btn.dataset.qb];
  if (!run) { clientLog('qbar: no action for ' + btn.dataset.qb); return; }
  btn.addEventListener('touchend', e => { e.preventDefault(); run(); }, { passive: false });
  btn.addEventListener('click', () => run());
});

function toggleDiag() {
  const el = $('diag');
  el.classList.toggle('show');
  if (el.classList.contains('show')) doResize();
}

let userScrolled = false;

function scrollTerm(lines) {
  if (activeSession !== null && terms[activeSession]) {
    userScrolled = true;
    terms[activeSession].scrollLines(lines);
  }
}

function scrollBottom() {
  if (activeSession === null) return;
  userScrolled = false;
  // T19 of W5: grid renderer scrolls its own wrap via DOM scroll.
  if (RENDERER_MODE === 'grid') {
    const grid = gridTerms[activeSession];
    if (!grid) return;
    scheduleOnce(() => {
      grid.wrap.scrollTop = grid.wrap.scrollHeight;
      window.scrollTo(0, 0);
    });
    return;
  }
  if (!terms[activeSession]) return;
  // Refit first so terminal uses full available height, then scroll
  try { fits[activeSession]?.fit(); } catch (e) { clientLog('scrollBottom fit: ' + e.message); }
  // T09 of W3: route through shared scheduler instead of ad-hoc rAF.
  scheduleOnce(() => {
    terms[activeSession]?.scrollToBottom();
    // Pin document to prevent iOS pushing page beyond visible area
    window.scrollTo(0, 0);
  });
}

function setupScrollZones() {
  const zones = [
    { el: $('sz-up'), lines: -10, flash: $('sf-up') },
    { el: $('sz-down'), lines: 10, flash: $('sf-down') }
  ];
  zones.forEach(z => {
    let interval = null;
    let startX = 0, startY = 0, scrollLocked = false;
    const icon = z.el.querySelector('.scroll-icon');
    const doScroll = () => {
      scrollTerm(z.lines);
      z.flash.style.opacity = '1';
      if (icon) icon.style.opacity = '0.6';
      setTimeout(() => { z.flash.style.opacity = '0'; if (icon) icon.style.opacity = '0'; }, 100);
    };
    z.el.addEventListener('touchstart', e => {
      // Prevent default to stop iOS from blurring the focused input (closing keyboard)
      e.preventDefault();
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      scrollLocked = false;
      // Delay scroll start to distinguish from horizontal swipe
      interval = setTimeout(() => {
        scrollLocked = true;
        doScroll();
        interval = setInterval(doScroll, 200);
      }, 150);
    }, { passive: false });
    z.el.addEventListener('touchmove', e => {
      if (scrollLocked) return;
      const dx = Math.abs(e.touches[0].clientX - startX);
      const dy = Math.abs(e.touches[0].clientY - startY);
      // If horizontal movement detected, cancel scroll -- let swipe gesture handle it
      if (dx > 10 && dx > dy) {
        if (interval) { clearTimeout(interval); clearInterval(interval); interval = null; }
      }
    }, { passive: true });
    z.el.addEventListener('touchend', () => {
      if (interval) { clearTimeout(interval); clearInterval(interval); interval = null; }
      // If no scroll happened and touch was short, fire one scroll
      if (!scrollLocked && !swiping) doScroll();
      scrollLocked = false;
    });
    z.el.addEventListener('touchcancel', () => {
      if (interval) { clearTimeout(interval); clearInterval(interval); interval = null; }
      scrollLocked = false;
    });
  });
}
setupScrollZones();

function qcmd(text) {
  qsend(text);
  setTimeout(() => qsend('\r'), 50);
}

// Slash commands -- populated dynamically from server on session connect.
// Server scans .claude/skills/ dirs and merges with built-in commands.
let commands = [];

const acEl = $('autocomplete');

function showAutocomplete(filter) {
  const matches = commands.filter(c => c.cmd.startsWith(filter)).slice(0, 15);
  if (!matches.length) { acEl.classList.remove('show'); return; }
  acEl.innerHTML = '';
  matches.forEach(c => {
    const btn = document.createElement('button');
    btn.className = 'ac-item';
    const cmdSpan = document.createElement('span');
    cmdSpan.className = 'ac-cmd';
    cmdSpan.textContent = c.cmd;
    const descSpan = document.createElement('span');
    descSpan.className = 'ac-desc';
    descSpan.textContent = c.desc;
    btn.appendChild(cmdSpan);
    btn.appendChild(descSpan);
    btn.onmousedown = e => e.preventDefault();
    btn.onclick = () => {
      msgInput.value = c.cmd;
      acEl.classList.remove('show');
      autoGrow();
      updateSendBtn();
      msgInput.focus();
    };
    acEl.appendChild(btn);
  });
  acEl.classList.add('show');
}

msgInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMsg(); acEl.classList.remove('show'); }
  if (e.key === 'Escape') {
    acEl.classList.remove('show');
    // T12: Esc is the way back out of the compose box into direct keystroke
    // mode. Without this the box is a one-way door on a hardware keyboard --
    // nothing but a tap on the terminal releases focus.
    if (hwKeyboardEnabled()) { e.preventDefault(); msgInput.blur(); }
  }
});
msgInput.addEventListener('input', () => {
  autoGrow(); updateSendBtn();
  const v = msgInput.value;
  if (v.startsWith('/') && !v.includes(' ')) {
    showAutocomplete(v);
  } else {
    acEl.classList.remove('show');
  }
});
msgInput.addEventListener('blur', () => {
  setTimeout(() => acEl.classList.remove('show'), 150);
});
// T14: the collapsed/expanded compose box is a CSS :focus-within state, but
// autoGrow's inline height has to be recomputed across the transition.
msgInput.addEventListener('focus', () => { lastMsgHeight = -1; autoGrow(); });
msgInput.addEventListener('blur', () => { lastMsgHeight = -1; autoGrow(); });

// ══ T12: hardware keyboard ══════════════════════════════════════════
// Until now there was no path from a physical key to the PTY at all. Every
// keydown listener in this file is scoped to a form field (session rename,
// TOTP box, inactivity tracker, compose box), and text reached the PTY only
// as one batched qsend(t + '\r') out of the compose box. That is a
// reasonable design for a phone, where the software keyboard already owns
// the bottom 40% of the screen -- and useless on an iPad with a hardware
// keyboard, where Esc, Ctrl-C, Tab-completion and arrow-key history are
// simply unreachable.
//
// This forwards keystrokes straight to the PTY whenever a terminal is on
// screen and no form field has focus. The compose box stays for long or
// multi-line prompts: Cmd-J focuses it (T08; was Cmd-K), Esc leaves it, a tap on the
// terminal leaves it.
//
// ATOMICITY (CLAUDE.md): text and Enter must reach the PTY as a SINGLE
// write -- separate writes race in the pipeline. So printable keys
// accumulate in kbPending for one short tick and Enter flushes
// pending + '\r' as ONE message. A fast typist, a key-repeat burst or a
// paste delivered as synthetic keydowns can therefore never split a line
// from its carriage return. Every other key flushes pending first, which
// preserves order (queueSend is a serialized promise chain).
//
// The whole feature sits behind a persisted setting -- default ON at tablet
// width, OFF on a phone, where the software keyboard drives the compose box
// and a stray physical key would be a surprise. If it misbehaves in the
// field it can be switched off from the gear menu without a deploy.
const HW_KB_KEY = 'cm-hw-keyboard';

function hwKeyboardEnabled() {
  const v = localStorage.getItem(HW_KB_KEY);
  if (v === 'on') return true;
  if (v === 'off') return false;
  return isWideLayout();  // default: on for tablets, off for phones
}

function setHwKeyboard(on) {
  localStorage.setItem(HW_KB_KEY, on ? 'on' : 'off');
  applyHwKeyboard();
}

function applyHwKeyboard() {
  const on = hwKeyboardEnabled();
  document.body.classList.toggle('hwkb', on);
  const box = $('set-hwkb');
  if (box) box.checked = on;
  msgInput.placeholder = on ? 'Compose (Cmd-J)' : 'Type a message...';
}

// ── T14: terminal font size ─────────────────────────────────────────
// The font was 13px because on a phone the software keyboard eats ~40% of
// the viewport and that is the only size that leaves useful context in the
// strip that remains. A hardware keyboard never raises that keyboard, so
// the constraint is gone: at 1366px, 16px still gives ~140 columns against
// the iPhone's ~48, and readable beats dense.
//
// A font change MUST end in a PTY resize -- the server's headless mirror is
// sized in cells, so if the client re-fits and the server does not, every
// row wraps against the wrong width until the next unrelated resize.
const FONT_SIZE_KEY = 'cm-font-size';
const FONT_MIN = 10, FONT_MAX = 24;
const FONT_DEFAULT_PHONE = 13, FONT_DEFAULT_TABLET = 16;

function defaultFontSize() { return isWideLayout() ? FONT_DEFAULT_TABLET : FONT_DEFAULT_PHONE; }

function getFontSize() {
  const v = parseInt(localStorage.getItem(FONT_SIZE_KEY), 10);
  if (Number.isFinite(v) && v >= FONT_MIN && v <= FONT_MAX) return v;
  return defaultFontSize();
}

function setFontSize(px) {
  const v = Math.max(FONT_MIN, Math.min(FONT_MAX, Math.round(Number(px) || 0)));
  localStorage.setItem(FONT_SIZE_KEY, String(v));
  applyFontSize();
}

function applyFontSize() {
  const px = getFontSize();
  document.documentElement.style.setProperty('--term-font-size', px + 'px');
  // xterm fallback path: its renderer owns its own font metrics.
  Object.keys(terms).forEach(id => {
    try { terms[id].options.fontSize = px; } catch (e) { clientLog('font xterm: ' + e.message); }
  });
  // Grid path: both cached metrics are now stale.
  invalidateGridMetrics();
  const val = $('set-font-val'); if (val) val.textContent = px;
  const slider = $('set-font'); if (slider) slider.value = px;
  // Re-window on the next frame (row height changed), then tell the server.
  scheduleOnce(() => {
    Object.keys(gridTerms).forEach(id => renderGridWindow(gridTerms[id]));
    doResize();
    refreshSettingsPanel();
  });
}

// ── Settings panel ──
function settingsOpen() { return $('settings-panel').classList.contains('open'); }

function openSettings() {
  $('settings-panel').classList.add('open');
  $('settings-btn').setAttribute('aria-expanded', 'true');
  refreshSettingsPanel();
}

function closeSettings() {
  srvDisarm();
  $('settings-panel').classList.remove('open');
  $('settings-btn').setAttribute('aria-expanded', 'false');
}

function toggleSettings() { settingsOpen() ? closeSettings() : openSettings(); }

function refreshSettingsPanel() {
  const box = $('set-hwkb');
  if (box) box.checked = hwKeyboardEnabled();
  const px = getFontSize();
  const val = $('set-font-val'); if (val) val.textContent = px;
  const slider = $('set-font'); if (slider) slider.value = px;
  const cols = $('set-cols');
  if (cols) {
    const d = activeSession !== null ? computeGridDims(gridTerms[activeSession]) : null;
    cols.textContent = d ? `Terminal is ${d.cols} x ${d.rows} cells.` : '';
  }
  // Re-ask origin on open rather than showing an answer up to half an hour old.
  srvLoad(true);
}

// ── Server control ──
// Restart, and update-then-restart, so neither needs the laptop.
//
// Confirmation is a two-step tap on the button itself, NOT confirm(). The
// native dialog blocks JS, and on iOS a blocked page loses the WebSocket --
// the same reason the passkey prompt is deferred until a user gesture. A
// dialog that kills the connection is a poor way to confirm restarting the
// thing on the other end of it.
let srvArmTimer = null;
let srvPollTimer = null;

function srvSetResult(text, kind) {
  const el = $('srv-result');
  if (!el) return;
  el.textContent = text || '';
  el.className = 'set-note' + (kind ? ' ' + kind : '');
}

function srvDisarm() {
  clearTimeout(srvArmTimer);
  for (const id of ['srv-restart', 'srv-update']) {
    const b = $(id);
    if (!b) continue;
    b.classList.remove('armed');
    if (b.dataset.label) b.textContent = b.dataset.label;
  }
}

// Returns true when this tap was the confirming one.
function srvArm(btn) {
  if (btn.classList.contains('armed')) { srvDisarm(); return true; }
  srvDisarm();
  btn.dataset.label = btn.dataset.label || btn.textContent;
  btn.textContent = 'Confirm?';
  btn.classList.add('armed');
  // Disarms itself, so a button left armed cannot fire later when the panel
  // is reopened for something else.
  srvArmTimer = setTimeout(srvDisarm, 5000);
  return false;
}

function srvRender(s) {
  const ver = $('srv-version');
  const note = $('srv-note');
  const upd = $('srv-update');
  if (!ver || !note || !upd) return;

  ver.textContent = (s.version ? 'v' + s.version : '?') + (s.commit ? ' · ' + s.commit : '');

  // Nothing supervises this process, so an exit would be the end of it -- and
  // the operator is on a phone with no way to start it again. Offering the
  // buttons anyway would be offering a trap.
  const rst = $('srv-restart');
  if (s.supervised === false) {
    note.textContent = 'Not running under PM2 -- restart and update are unavailable.';
    note.className = 'set-note';
    upd.disabled = true;
    if (rst) rst.disabled = true;
    upd.classList.remove('busy');
    return;
  }
  if (rst) rst.disabled = false;

  if (s.updateRunning) {
    note.textContent = 'Updating...';
    note.className = 'set-note';
    upd.disabled = true;
    upd.classList.add('busy');
  } else if (s.remote && s.remote.error) {
    // Could not ask origin. That is not "up to date", and showing it as such
    // would be the kind of confidently wrong answer that stops anyone looking.
    note.textContent = 'Update check failed -- ' + s.remote.error;
    note.className = 'set-note';
    upd.disabled = false;
    upd.classList.remove('busy');
  } else if (s.updateAvailable) {
    note.textContent = 'Update available: ' + s.commit + ' -> ' + s.remote.commit;
    note.className = 'set-note avail';
    upd.disabled = false;
    upd.classList.remove('busy');
  } else {
    note.textContent = 'Up to date' + (s.branch ? ' on ' + s.branch : '') + '.';
    note.className = 'set-note';
    // Enabled even with nothing to pull. update.sh is idempotent and does more
    // than pull -- it re-asserts the secret file permissions and restarts --
    // so "run update.sh from my iPad" stays possible. The note above already
    // says whether there is anything to fetch; disabling the button would
    // decide that for the operator.
    upd.disabled = false;
    upd.classList.remove('busy');
  }

  const last = s.lastUpdate;
  const resultEl = $('srv-result');
  if (last && !last.error && last.exitCode === 0 && last.changed) {
    // The new client only arrives on a reload: index.html cache-busts app.js
    // with ?v=<version>, and iOS Safari serves the old one until the document
    // is fetched again.
    srvSetResult('Updated ' + last.from + ' -> ' + last.to + '. Tap to reload the client.', 'ok');
    if (resultEl) resultEl.onclick = () => location.reload();
  } else if (last && (last.error || last.exitCode !== 0)) {
    // update.sh exits non-zero when it finished DEGRADED, so this is the
    // script's own verdict rather than merely "did it crash".
    srvSetResult('Last update failed (' + (last.error || 'exit ' + last.exitCode) + ').', 'bad');
    if (resultEl) resultEl.onclick = null;
  }
}

async function srvStatus(fresh) {
  if (!sessionToken) return null;
  const res = await fetch('/api/server/' + (fresh ? 'check' : 'status'), {
    method: fresh ? 'POST' : 'GET',
    headers: fresh
      ? { 'Content-Type': 'application/json', 'X-Session-Token': sessionToken }
      : { 'X-Session-Token': sessionToken },
    body: fresh ? '{}' : undefined,
  });
  if (!res.ok) throw new Error('status ' + res.status);
  return res.json();
}

async function srvLoad(fresh) {
  try {
    const s = await srvStatus(fresh);
    if (s) srvRender(s);
    return s;
  } catch (e) {
    const note = $('srv-note');
    if (note) { note.textContent = 'Server status unavailable.'; note.className = 'set-note'; }
    return null;
  }
}

// Liveness is asked UNAUTHENTICATED, and that is the point of this function
// rather than an incidental detail.
//
// A restart wipes the in-memory token map, so this client's token is dead the
// moment the server comes back. Polling /api/server/status -- which is
// requireSession-guarded -- can therefore NEVER succeed after a restart: it
// 401s until the timeout and then reports "taking longer than expected" about
// a server that came back fine, recovered its sessions and is serving
// requests. /api/auth/status is already public and already exists, so it is
// what gets asked.
async function srvAlive() {
  try {
    const r = await fetch('/api/auth/status');
    return r.ok;
  } catch (e) { return false; }
}

// One probe, three distinguishable answers -- and the distinctions are the
// whole mechanism:
//   'down'        the server is not answering; it is mid-restart
//   'signed-out'  it IS answering but our token is dead, which only happens
//                 because it restarted. A positive signal, not an error.
//   <status>      answering and still ours, so the update is still running
async function srvProbe() {
  if (!(await srvAlive())) return 'down';
  try {
    const res = await fetch('/api/server/status', { headers: { 'X-Session-Token': sessionToken } });
    if (res.status === 401 || res.status === 403) return 'signed-out';
    if (!res.ok) return 'down';
    return await res.json();
  } catch (e) { return 'down'; }
}

// The two flows end differently and cannot share one condition.
//
// 'signed-out' is the completion signal for BOTH, because it is proof the
// server restarted: only a restart empties the token map. Waiting to observe
// the server DOWN instead does not work -- it comes back inside two seconds
// and the poll runs every three, so the gap is routinely missed entirely.
//
// The difference is what a VALID status means. For a restart it means the
// restart has not happened yet, so keep waiting. For an update it means
// update.sh failed early and never restarted, and its recorded verdict is the
// answer -- so that finishes the poll.
function srvPollUntilBack(label, opts) {
  opts = opts || {};
  const onlySignOut = !!opts.onlySignOut;
  const maxTicks = opts.maxTicks || 60;
  clearInterval(srvPollTimer);
  let ticks = 0;
  srvPollTimer = setInterval(async () => {
    ticks++;
    const p = await srvProbe();

    if (p === 'signed-out') {
      clearInterval(srvPollTimer);
      srvSetResult(label + ' done -- sign in again to see the result.', 'ok');
      return;
    }
    if (!onlySignOut && p !== 'down' && !p.updateRunning) {
      clearInterval(srvPollTimer);
      srvRender(p);
      return;
    }

    if (ticks > maxTicks) {
      clearInterval(srvPollTimer);
      srvSetResult(label + ' is taking longer than expected -- check the laptop.', 'bad');
    }
  }, 3000);
}

$('srv-restart')?.addEventListener('click', async () => {
  const btn = $('srv-restart');
  if (!srvArm(btn)) return;
  // Both halves matter. The Claude sessions survive -- that is the whole
  // point of the backend -- but session TOKENS live in an in-memory map, so
  // the restart signs this client out. Saying so before the tap beats
  // discovering it while hunting for an authenticator app.
  srvSetResult('Restarting -- Claude sessions survive; you will need to sign in again.', null);
  try {
    await fetch('/api/server/restart', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Token': sessionToken },
      body: '{}',
    });
  } catch (e) { /* the socket dropping IS the success signal here */ }
  // Only a restart empties the token map, so being signed out is the proof.
  srvPollUntilBack('Restart', { onlySignOut: true, maxTicks: 60 });
});

$('srv-update')?.addEventListener('click', async () => {
  const btn = $('srv-update');
  if (!srvArm(btn)) return;
  try {
    const res = await fetch('/api/server/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Token': sessionToken },
      body: '{}',
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.ok) {
      srvSetResult(body.reason || 'Update could not start.', 'bad');
      return;
    }
    srvSetResult('Updating -- the server restarts when it finishes.', null);
    // update.sh stays up for its whole run and restarts last, so this must
    // not stop at the first liveness check. npm ci can make it slow.
    srvPollUntilBack('Update', { onlySignOut: false, maxTicks: 160 });
  } catch (e) {
    srvSetResult('Update could not start: ' + e.message, 'bad');
  }
});

$('settings-btn').addEventListener('click', e => { e.preventDefault(); toggleSettings(); });
$('set-done').addEventListener('click', () => { closeSettings(); $('settings-btn').focus(); });
$('set-hwkb').addEventListener('change', e => setHwKeyboard(e.target.checked));
$('set-font').addEventListener('input', e => setFontSize(e.target.value));
document.addEventListener('click', e => {
  if (!settingsOpen()) return;
  if (e.target.closest('#settings-panel') || e.target.closest('#settings-btn')) return;
  closeSettings();
});

// ── Key -> byte translation ──
// Bare VT sequences, matching what a real terminal emits. Home/End use the
// CSI H/F forms already used by clearPrompt(), so the two input paths agree.
const KB_SPECIAL = {
  Enter: '\r',
  Backspace: '\x7f',
  Tab: '\t',
  Escape: '\x1b',
  ArrowUp: '\x1b[A', ArrowDown: '\x1b[B', ArrowRight: '\x1b[C', ArrowLeft: '\x1b[D',
  Home: '\x1b[H', End: '\x1b[F',
  PageUp: '\x1b[5~', PageDown: '\x1b[6~',
  Insert: '\x1b[2~', Delete: '\x1b[3~',
  F1: '\x1bOP', F2: '\x1bOQ', F3: '\x1bOR', F4: '\x1bOS',
  F5: '\x1b[15~', F6: '\x1b[17~', F7: '\x1b[18~', F8: '\x1b[19~',
  F9: '\x1b[20~', F10: '\x1b[21~', F11: '\x1b[23~', F12: '\x1b[24~',
};
// Cursor/navigation keys that take a modifier parameter (CSI 1 ; mod X).
const KB_CURSOR = { ArrowUp: 'A', ArrowDown: 'B', ArrowRight: 'C', ArrowLeft: 'D', Home: 'H', End: 'F' };
// Control codes that are not Ctrl+letter.
const KB_CTRL_PUNCT = {
  '[': '\x1b', '\\': '\x1c', ']': '\x1d', '^': '\x1e', '_': '\x1f',
  ' ': '\x00', '@': '\x00', '?': '\x7f',
};

function keyToSequence(e) {
  const k = e.key;
  // Modified cursor keys: CSI 1 ; mod <letter>. mod = 1 + shift + 2*alt + 4*ctrl.
  if (KB_CURSOR[k]) {
    const mod = 1 + (e.shiftKey ? 1 : 0) + (e.altKey ? 2 : 0) + (e.ctrlKey ? 4 : 0);
    if (mod > 1) return '\x1b[1;' + mod + KB_CURSOR[k];
    return KB_SPECIAL[k];
  }
  // Tab must be claimed (preventDefault) or focus escapes the terminal to
  // the next tabbable element -- which on this page is the compose box.
  if (k === 'Tab') return e.shiftKey ? '\x1b[Z' : '\t';
  if (e.ctrlKey && !e.altKey && k.length === 1) {
    const lower = k.toLowerCase();
    if (lower >= 'a' && lower <= 'z') return String.fromCharCode(lower.charCodeAt(0) - 96);
    if (KB_CTRL_PUNCT[k] !== undefined) return KB_CTRL_PUNCT[k];
    return null;  // unknown Ctrl chord -- leave it to the browser
  }
  if (KB_SPECIAL[k] !== undefined) return KB_SPECIAL[k];
  // Printable. Alt/Option prefixes ESC, the standard meta encoding.
  if (k.length === 1 && !e.ctrlKey && !e.metaKey) return e.altKey ? '\x1b' + k : k;
  return null;
}

// ── Atomic write buffer ──
const KB_COALESCE_MS = 4;
let kbPending = '';
let kbFlushTimer = 0;

function kbQueueChar(s) {
  kbPending += s;
  if (kbFlushTimer) return;
  kbFlushTimer = setTimeout(() => { kbFlushTimer = 0; kbFlush(); }, KB_COALESCE_MS);
}

function kbFlush(extra) {
  if (kbFlushTimer) { clearTimeout(kbFlushTimer); kbFlushTimer = 0; }
  const data = kbPending + (extra || '');
  kbPending = '';
  if (data) qsend(data);
}

// ── Focus rules ──
function isTypingTarget(el) {
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

function appIsVisible() {
  // offsetParent is null exactly when the element (or an ancestor) is
  // display:none, which is the pre-auth state of #app. The lock overlay
  // leaves #app displayed, so it needs its own check.
  return !!appEl && appEl.offsetParent !== null && !authScreen.classList.contains('active');
}

function terminalHasKeyboardFocus() {
  if (!hwKeyboardEnabled()) return false;
  if (activeSession === null) return false;
  if (!appIsVisible()) return false;
  if (settingsOpen()) return false;
  if (kbOverlayOpen()) return false;   // T08: switcher / key list are modal
  // T07: the portrait sheet is modal, and a pane control reached by keyboard
  // (focus-visible) keeps its keys -- Enter/Space must activate the row, not
  // reach the PTY. A pointer pick hands focus back (selectSession blurs).
  if (sidepaneOpen()) return false;
  const ae = document.activeElement;
  if (ae && ae.closest && ae.closest('#chrome-col') && ae.matches(':focus-visible')) return false;
  return !isTypingTarget(ae);
}

function focusCompose() {
  msgInput.focus();
  const end = msgInput.value.length;
  try { msgInput.setSelectionRange(end, end); } catch (e) { /* not supported */ }
}

// ── Cmd-based app shortcuts ──
// Cmd chords never reach the PTY: on iPadOS they are the app-level verbs.
// Anything not claimed here falls through to the browser (Cmd-R, Cmd-Tab).
// Safari's own chords (Cmd-T/W/L/R/Q/Tab/Space) are deliberately never
// claimed. T08 (D8): Cmd-K is the session switcher; the compose box moved to
// Cmd-J.
function handleAppShortcut(e) {
  if (!e.metaKey || e.ctrlKey) return false;
  if (!appIsVisible()) return false;
  const k = e.key;
  if (!e.shiftKey && (k === 'k' || k === 'K')) { e.preventDefault(); openSwitcher(); return true; }
  if (!e.shiftKey && (k === 'j' || k === 'J')) { e.preventDefault(); focusCompose(); return true; }
  if (k === '/') { e.preventDefault(); toggleSettings(); return true; }
  if (!e.shiftKey && k >= '1' && k <= '9') {
    const idx = Number(k) - 1;
    if (idx < sessionList.length) { e.preventDefault(); switchTo(sessionList[idx].id); return true; }
    return false;
  }
  if (e.shiftKey && (k === 'ArrowRight' || k === 'ArrowLeft')) {
    e.preventDefault();
    navigateTab(k === 'ArrowRight' ? 1 : -1);
    return true;
  }
  return false;
}

function onGlobalKeyDown(e) {
  if (e.defaultPrevented) return;
  // IME composition (Japanese/Chinese input, and the iOS autocorrect bar in
  // some locales) delivers keyCode 229 until the composition commits.
  // Forwarding those would send the pre-edit buffer twice.
  if (e.isComposing || e.keyCode === 229) return;
  // T08: an open overlay owns every key (its own listener runs first).
  if (kbOverlayOpen()) return;
  if (e.key === 'Escape' && settingsOpen()) { e.preventDefault(); closeSettings(); return; }
  if (e.key === 'Escape' && sidepaneOpen()) { e.preventDefault(); closeSidepane(); return; }
  // T08: a bare modifier is not the key after the prefix -- '?' arrives as
  // Shift, then '?'.
  if (kbPrefixArmed && KB_MODIFIER_KEYS.has(e.key)) return;
  if (kbPrefixArmed && (e.metaKey || !terminalHasKeyboardFocus())) kbDisarmPrefix();
  if (handleAppShortcut(e)) return;
  if (!terminalHasKeyboardFocus()) return;
  if (e.metaKey) return;
  if (kbPrefixArmed) { e.preventDefault(); kbDisarmPrefix(); kbHandlePrefixed(e); return; }
  if (kbIsPrefixChord(e)) { e.preventDefault(); kbFlush(); kbArmPrefix(); return; }
  const seq = keyToSequence(e);
  if (seq === null || seq === undefined) return;
  e.preventDefault();
  if (e.key === 'Enter') { kbFlush('\r'); return; }   // atomic: pending text + CR
  if (e.key.length === 1 && !e.ctrlKey && !e.altKey) { kbQueueChar(seq); return; }
  kbFlush(seq);
}

document.addEventListener('keydown', onGlobalKeyDown);

// Cmd-V / trackpad paste into the terminal. One write, plain text, no
// bracketed paste -- the Claude Code TUI ignores \r after a paste sequence
// (CLAUDE.md), so the compose box path and this one agree.
document.addEventListener('paste', e => {
  if (!terminalHasKeyboardFocus()) return;
  const text = e.clipboardData && e.clipboardData.getData('text');
  if (!text) return;
  e.preventDefault();
  kbFlush(text);
});

// == T08: prefix keys, switcher, key list, focus reporting ===============
// D8: shortcuts mirror herdr's defaults. herdr's OWN prefix is also ctrl+b
// (herdr --default-config; herdr-config.toml does not rebind it), so the web
// must not steal it. ctrl+b arms a short prefix state here and HOLDS the
// byte. The next key is either one the web handles -- n/p/1-9/a/?/s, all
// session-level -- or it is forwarded as ctrl+b + that key in ONE write, so
// herdr receives exactly the chord a real terminal would have sent and its
// own bindings (v split, minus split, h/j/k/l focus, z zoom, ...) keep
// working. ctrl+b ctrl+b sends one literal ctrl+b.
//
// Shadowed on purpose: herdr's n/p/1-9 switch herdr TABS, and every session
// here is one herdr tab, so they would do nothing; the web binds the same
// letters to sessions. herdr's ? (help) and s (settings) are replaced by the
// key list below and the sessions pane.
const KB_PREFIX_BYTE = '\x02';
const KB_PREFIX_MS = 1500;
const KB_FLASH_MS = 1600;
const KB_MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Fn', 'OS']);
// var, not let: the prefix/overlay/focus state is read from paths
// (switchTo, the message handler) that must never hit a TDZ.
var kbPrefixArmed = false;
var kbPrefixTimer = 0;
var kbChipTimer = 0;
const kbChip = $('kb-chip');

function kbIsPrefixChord(e) {
  return e.ctrlKey && !e.altKey && !e.metaKey && (e.key === 'b' || e.key === 'B');
}

function kbChipShow(text, sticky) {
  clearTimeout(kbChipTimer);
  kbChip.textContent = text;
  kbChip.hidden = false;
  kbChipTimer = sticky ? 0 : setTimeout(kbChipHide, KB_FLASH_MS);
}
function kbChipHide() { clearTimeout(kbChipTimer); kbChipTimer = 0; kbChip.hidden = true; }

function kbArmPrefix() {
  kbPrefixArmed = true;
  clearTimeout(kbPrefixTimer);
  kbPrefixTimer = setTimeout(kbDisarmPrefix, KB_PREFIX_MS);
  kbChipShow('ctrl+b   n p 1-9 a ? s  --  any other key goes to herdr', true);
}

// Timing out sends nothing: herdr never saw the prefix, so it is not waiting.
function kbDisarmPrefix() {
  kbPrefixArmed = false;
  clearTimeout(kbPrefixTimer);
  kbPrefixTimer = 0;
  if (!kbChipTimer) kbChipHide();
}

// The one place a held prefix is released to the pane: prefix + key, atomic.
function kbPrefixPassthrough(seq) { kbFlush(KB_PREFIX_BYTE + seq); }

function kbSessionOrder() { return sidepaneOrder(sessionList); }

function kbStepSession(dir) {
  const order = kbSessionOrder();
  if (!order.length) return false;
  const i = order.findIndex(s => s.id === activeSession);
  const next = i < 0 ? order[dir > 0 ? 0 : order.length - 1]
                     : order[(i + dir + order.length) % order.length];
  return selectSession(next.id);
}

function kbHandlePrefixed(e) {
  if (kbIsPrefixChord(e)) { kbFlush(KB_PREFIX_BYTE); return; }
  const k = e.key;
  if (k === 'Escape') return;   // cancel: nothing was sent, nothing to undo
  if (!e.ctrlKey && !e.altKey && !e.metaKey) {
    if (k === 'n' || k === 'p') { kbStepSession(k === 'n' ? 1 : -1); return; }
    if (k.length === 1 && k >= '1' && k <= '9') {
      const s = kbSessionOrder()[Number(k) - 1];
      if (s) selectSession(s.id); else kbChipShow('No session ' + k);
      return;
    }
    if (k === 'a') { if (!nextNeedsAttention()) kbChipShow('Nothing needs attention'); return; }
    if (k === '?') { openHelp(); return; }
    if (k === 's') {
      if (sidepaneIsModal()) toggleSidepane();
      else kbChipShow(isWideLayout() ? 'Sessions are pinned in landscape' : 'No sessions pane at this width');
      return;
    }
  }
  const seq = keyToSequence(e);
  if (seq === null || seq === undefined) return;   // nothing herdr could receive
  kbPrefixPassthrough(seq);
}

// -- Overlays: Cmd-K switcher and the ctrl+b ? key list --
// Glass sheets over the terminal (D3: chrome, never content). role=dialog +
// aria-modal, focus trapped while open, and focus handed back to the
// terminal's input on close: the page itself in hardware-keyboard mode, the
// compose box when that is where the operator was.
var kbOverlay = null;   // { el, kind, input, prevFocus }
const kbSwitcherEl = $('kb-switcher'), kbHelpEl = $('kb-help');
const kswInput = $('ksw-input'), kswList = $('ksw-list'), kswEmpty = $('ksw-empty');
const khelpInput = $('khelp-input'), khelpList = $('khelp-list'), khelpEmpty = $('khelp-empty');
var kswItems = [];      // [{ s, li }] in display order
var kswIndex = -1;

function kbOverlayOpen() { return !!kbOverlay; }

function kbOpenOverlay(kind) {
  const el = kind === 'switcher' ? kbSwitcherEl : kbHelpEl;
  const input = kind === 'switcher' ? kswInput : khelpInput;
  const prev = kbOverlay ? kbOverlay.prevFocus : document.activeElement;
  if (kbOverlay) kbCloseOverlay(false);
  kbDisarmPrefix();
  closeSettings();
  closeSidepane();
  kbOverlay = { el, kind, input, prevFocus: prev };
  input.value = '';
  el.hidden = false;
  try { input.focus({ preventScroll: true }); } catch (e) { input.focus(); }
}

function kbCloseOverlay(restore) {
  const o = kbOverlay;
  if (!o) return;
  kbOverlay = null;
  o.el.hidden = true;
  if (restore !== false) kbRestoreTerminalFocus(o.prevFocus);
}

function kbRestoreTerminalFocus(prev) {
  const ae = document.activeElement;
  if (ae && ae !== document.body && ae.blur) ae.blur();
  if (prev === msgInput) focusCompose();
}

function kbFocusables(el) {
  return [...el.querySelectorAll('input, button')].filter(x => !x.disabled && x.offsetParent !== null);
}

function kbOverlayKeyDown(e) {
  if (!kbOverlay || e.isComposing || e.keyCode === 229) return;
  const k = e.key;
  if (k === 'Escape') { e.preventDefault(); kbCloseOverlay(); return; }
  if (k === 'Tab') {
    // Trap: cycle among the sheet's own controls.
    e.preventDefault();
    const f = kbFocusables(kbOverlay.el);
    if (!f.length) return;
    const i = f.indexOf(document.activeElement);
    f[(i + (e.shiftKey ? -1 : 1) + f.length) % f.length].focus();
    return;
  }
  if (e.metaKey && !e.ctrlKey && (k === 'k' || k === 'K')) {
    e.preventDefault();
    if (kbOverlay.kind === 'switcher') kbCloseOverlay(); else openSwitcher();
    return;
  }
  if (kbOverlay.kind !== 'switcher') return;
  if (k === 'ArrowDown' || k === 'ArrowUp') {
    e.preventDefault();
    if (kswItems.length) kswSetIndex((kswIndex + (k === 'ArrowDown' ? 1 : -1) + kswItems.length) % kswItems.length);
    return;
  }
  if (k === 'Enter') {
    e.preventDefault();
    if (kswIndex >= 0 && kswItems[kswIndex]) kswPick(kswItems[kswIndex].s.id);
  }
}

// -- switcher --
function kswHaystack(s) {
  const a = s.agent || null;
  const cwd = (a && a.cwd) || s.dir || '';
  const cwdBase = baseName(cwd);
  return [s.name, cwd, cwdBase, worktreeLabel(a && a.worktree, cwdBase),
          (a && (a.title || a.agent)) || ''].join(' ').toLowerCase();
}

function kswRender() {
  const terms = kswInput.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const hits = kbSessionOrder().filter(s => {
    const h = kswHaystack(s);
    return terms.every(t => h.includes(t));
  });
  kswList.textContent = '';
  kswIndex = -1;
  kswItems = hits.map(s => {
    const status = sessionStatus(s);
    const a = s.agent || null;
    const cwdBase = baseName((a && a.cwd) || s.dir);
    const title = (a && (a.title || a.agent)) || '';
    const li = document.createElement('li');
    li.className = 'kb-opt';
    li.id = 'ksw-opt-' + s.id;
    li.dataset.id = String(s.id);
    li.dataset.status = status;
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', 'false');
    const state = document.createElement('span');
    state.className = 'sp-state';
    state.appendChild(svgUse('#s-' + status).svg);
    const unseen = document.createElement('span');
    unseen.className = 'sp-unseen';
    state.appendChild(unseen);
    const text = document.createElement('span');
    text.className = 'kb-opt-text';
    const name = document.createElement('span');
    name.className = 'kb-opt-name';
    name.textContent = s.name;
    const meta = document.createElement('span');
    meta.className = 'kb-opt-meta';
    meta.textContent = cwdBase + (title ? '  -  ' + title : '');
    text.append(name, meta);
    li.append(state, text);
    if (s.id === activeSession) {
      const cur = document.createElement('span');
      cur.className = 'kb-opt-cur';
      cur.textContent = 'Current';
      li.appendChild(cur);
    }
    li.setAttribute('aria-label', s.name + ', ' + SP_STATUS_TEXT[status]
      + (cwdBase ? ', in ' + cwdBase : '') + (title ? ', ' + title : '')
      + (s.id === activeSession ? ', current' : ''));
    li.addEventListener('click', () => kswPick(s.id));
    kswList.appendChild(li);
    return { s, li };
  });
  kswEmpty.hidden = kswItems.length > 0;
  // With no query the first pick is somewhere else to go; with one, the best hit.
  let start = 0;
  if (!terms.length && kswItems.length > 1 && kswItems[0].s.id === activeSession) start = 1;
  kswSetIndex(kswItems.length ? start : -1);
}

function kswSetIndex(i) {
  if (kswIndex >= 0 && kswItems[kswIndex]) kswItems[kswIndex].li.setAttribute('aria-selected', 'false');
  kswIndex = i;
  if (i >= 0 && kswItems[i]) {
    kswItems[i].li.setAttribute('aria-selected', 'true');
    kswInput.setAttribute('aria-activedescendant', kswItems[i].li.id);
    kswItems[i].li.scrollIntoView({ block: 'nearest' });
  } else {
    kswInput.removeAttribute('aria-activedescendant');
  }
}

// A pick lands on the terminal, whatever had focus before the switcher.
function kswPick(id) {
  kbCloseOverlay(false);
  kbRestoreTerminalFocus(null);
  selectSession(id);
}

function openSwitcher() {
  if (!appIsVisible()) return;
  kbOpenOverlay('switcher');
  kswRender();
}

// -- key list (ctrl+b ?) --
// Web keys first, then the herdr keys that pass through untouched (herdr's
// default keymap). Filterable by key or description.
const KB_HELP = [
  { group: 'This app', rows: [
    ['Cmd-K', 'Switch session: search by name, folder or title'],
    ['Cmd-J', 'Compose box for long or multi-line prompts (Esc returns)'],
    ['Cmd-/', 'Settings'],
    ['Cmd-1 ... Cmd-9', 'Session by creation order'],
    ['Cmd-Shift-Left / Right', 'Previous / next session'],
    ['ctrl+b n', 'Next session (sessions-pane order)'],
    ['ctrl+b p', 'Previous session'],
    ['ctrl+b 1 ... 9', 'Session by its position in the sessions pane'],
    ['ctrl+b a', 'Next session needing you: blocked first, then finished and unseen'],
    ['ctrl+b ?', 'This list'],
    ['ctrl+b s', 'Show or hide the sessions pane (portrait)'],
    ['ctrl+b ctrl+b', 'Send one literal ctrl+b to the terminal'],
  ] },
  { group: 'herdr (passed through)', rows: [
    ['ctrl+b v', 'Split pane vertically'],
    ['ctrl+b minus', 'Split pane horizontally'],
    ['ctrl+b h / j / k / l', 'Focus pane left / down / up / right'],
    ['ctrl+b tab', 'Next pane (shift+tab: previous)'],
    ['ctrl+b x', 'Close pane'],
    ['ctrl+b z', 'Zoom pane'],
    ['ctrl+b r', 'Resize mode'],
    ['ctrl+b e', 'Edit scrollback'],
    ['ctrl+b shift+p', 'Rename pane'],
    ['ctrl+b c', 'New herdr tab'],
    ['ctrl+b shift+t', 'Rename herdr tab'],
    ['ctrl+b shift+x', 'Close herdr tab'],
    ['ctrl+b b', 'Toggle herdr sidebar'],
    ['ctrl+b w', 'Workspace picker'],
    ['ctrl+b g', 'Go to'],
    ['ctrl+b o', 'Open notification target'],
    ['ctrl+b shift+n', 'New workspace'],
    ['ctrl+b shift+g', 'New worktree'],
    ['ctrl+b shift+w', 'Rename workspace'],
    ['ctrl+b shift+d', 'Close workspace'],
    ['ctrl+b shift+r', 'Reload herdr config'],
    ['ctrl+b q', 'Detach the herdr client'],
  ] },
];
const KB_HELP_NOTE = "herdr's own ctrl+b n / p / 1-9 (tabs), ? and s are answered by this app: "
  + 'each session here is one herdr tab.';

var khelpRows = null;   // [{ li, head, text }]
var khelpNote = null;

function khelpBuild() {
  if (khelpRows) return;
  khelpRows = [];
  for (const g of KB_HELP) {
    const head = document.createElement('li');
    head.className = 'kb-group';
    head.textContent = g.group;
    khelpList.appendChild(head);
    for (const [keys, desc] of g.rows) {
      const li = document.createElement('li');
      li.className = 'kb-row';
      const kbd = document.createElement('kbd');
      kbd.textContent = keys;
      const d = document.createElement('span');
      d.textContent = desc;
      li.append(kbd, d);
      khelpList.appendChild(li);
      khelpRows.push({ li, head, text: (keys + ' ' + desc + ' ' + g.group).toLowerCase() });
    }
  }
  khelpNote = document.createElement('li');
  khelpNote.className = 'kb-note';
  khelpNote.textContent = KB_HELP_NOTE;
  khelpList.appendChild(khelpNote);
}

function khelpRender() {
  const terms = khelpInput.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const shownHeads = new Set();
  let n = 0;
  for (const r of khelpRows) {
    const show = terms.every(t => r.text.includes(t));
    r.li.hidden = !show;
    if (show) { n++; shownHeads.add(r.head); }
  }
  for (const r of khelpRows) r.head.hidden = !shownHeads.has(r.head);
  khelpNote.hidden = terms.length > 0;
  khelpEmpty.hidden = n > 0;
}

function openHelp() {
  if (!appIsVisible()) return;
  khelpBuild();
  kbOpenOverlay('help');
  khelpRender();
}

kswInput.addEventListener('input', kswRender);
khelpInput.addEventListener('input', khelpRender);
for (const el of [kbSwitcherEl, kbHelpEl]) {
  el.addEventListener('keydown', kbOverlayKeyDown);
  el.querySelectorAll('[data-kb-close]').forEach(b => b.addEventListener('click', () => kbCloseOverlay()));
}
// Trap focus that arrives from outside (a pointer, an assistive technology).
document.addEventListener('focusin', e => {
  if (kbOverlay && !kbOverlay.el.contains(e.target)) kbOverlay.input.focus();
});

// -- Focus reporting (CSI ?1004h) --
// Consistent with mouse reporting (T22): the server reads the mode off the
// headless mirror, pushes each transition in the same mouse-mode message
// (mouse.focus), and writes the bytes itself -- it re-checks the mode, so a
// report racing a ?1004l is dropped there. The client only says which
// session is focused, and only while that session's app asked to be told.
// Focused = the page is visible AND the window has focus AND it is the
// session on screen; switching sessions is out for one and in for the other.
var kbWinFocused = typeof document.hasFocus === 'function' ? document.hasFocus() : true;
var kbFocusSent = new Map();   // session id -> last report sent (true = in)

function kbFocusTarget() {
  if (document.visibilityState !== 'visible' || !kbWinFocused) return null;
  return activeSession;
}

function syncFocusReport() {
  if (RENDERER_MODE !== 'grid' || !ws || ws.readyState !== 1) return;
  const target = kbFocusTarget();
  for (const id of Object.keys(gridTerms)) {
    const sid = Number(id);
    const grid = gridTerms[id];
    const on = !!(grid && grid.mouse && grid.mouse.focus);
    if (!on) { kbFocusSent.delete(sid); continue; }
    const want = sid === target;
    const last = kbFocusSent.get(sid);
    // In when it becomes focused (or the mode just turned on while it was);
    // out only to a session that was last told in.
    if (want ? last !== true : last === true) {
      kbFocusSent.set(sid, want);
      queueSend({ type: 'focus', session: sid, focused: want });
    }
  }
}

window.addEventListener('focus', () => { kbWinFocused = true; syncFocusReport(); });
window.addEventListener('blur', () => { kbWinFocused = false; syncFocusReport(); });
document.addEventListener('visibilitychange', () => syncFocusReport());
// A key or a touch is proof the window has focus, whatever hasFocus() said at
// load -- so a missed initial 'focus' event cannot leave a pane never told.
for (const t of ['keydown', 'pointerdown']) {
  document.addEventListener(t, () => {
    if (!kbWinFocused) { kbWinFocused = true; syncFocusReport(); }
  }, { capture: true, passive: true });
}

applyHwKeyboard();
applyFontSize();

// T19 of W5: grid mode has no fit addon -- dims come from a probe span.
// Extracted from doResize by T14 so the font-size setting, newSession and
// the settings readout all compute columns the same way.
function computeGridDims(grid) {
  if (!grid || grid.wrap.clientWidth === 0) return null;
  // T11: the renderer's own cached cell, so the cols/rows the server is told
  // are computed from the same numbers the rows, cursor and mouse use.
  if (!probeGridMetrics(grid)) return null;
  return {
    cols: Math.max(10, Math.floor(grid.wrap.clientWidth / grid.charWidth)),
    rows: Math.max(5, Math.floor(grid.wrap.clientHeight / grid.rowHeight)),
  };
}

let lastCols = 0, lastRows = 0;
function doResize() {
  if (activeSession === null) return;
  if (RENDERER_MODE === 'grid') {
    const grid = gridTerms[activeSession];
    const dims = computeGridDims(grid);
    if (!dims) return;
    const { cols, rows } = dims;
    // Skip iff the SERVER already has these dims (per the latest snapshot).
    // Don't compare against lastCols -- another client connected to the same
    // session can resize the PTY out from under us, and a stale local cache
    // would silently let the mismatch persist (rows wider than viewport ->
    // visible right-side clipping).
    if (cols === grid.cols && rows === grid.rows) return;
    if (ws && ws.readyState === 1) {
      queueSend({ type: 'resize', cols, rows });
      updateDiag(cols, rows);
    }
    return;
  }
  if (fits[activeSession]) {
    try {
      const dims = fits[activeSession].proposeDimensions();
      if (!dims) return;
      // Only refit if terminal dimensions actually changed (avoids unnecessary re-render)
      if (dims.cols === lastCols && dims.rows === lastRows) return;
      lastCols = dims.cols;
      lastRows = dims.rows;
      fits[activeSession].fit();
      if (ws && ws.readyState === 1) {
        queueSend({ type: 'resize', cols: dims.cols, rows: dims.rows });
        updateDiag(dims.cols, dims.rows);
      }
    } catch (e) { clientLog('doResize: ' + e.message); }
  }
}

// ── Diagnostic Overlay ──
function updateDiag(cols, rows) {
  const el = $('diag');
  if (!el || !el.classList.contains('show')) return;
  const vvH = window.visualViewport ? Math.round(window.visualViewport.height) : '?';
  const vvW = window.visualViewport ? Math.round(window.visualViewport.width) : '?';
  const wH = window.innerHeight;
  const wW = window.innerWidth;
  const ta = document.getElementById('term-area');
  const taH = ta ? ta.clientHeight : '?';
  el.textContent = `PTY:${cols}x${rows} | VP:${vvW}x${vvH} | Win:${wW}x${wH} | Term:${taH}px`;
}

// Width-only resize handler (orientation changes, not keyboard).
// Debounced 100 ms per D9/T06: rapid drag or orientation events coalesce
// into one PTY resize call, so the CLI sees stable dimensions instead
// of frame churn during the gesture.
let lastWidth = window.innerWidth;
let resizeDebounce = 0;
window.addEventListener('resize', () => {
  const w = window.innerWidth;
  if (w !== lastWidth) {
    lastWidth = w;
    if (resizeDebounce) clearTimeout(resizeDebounce);
    resizeDebounce = setTimeout(() => { resizeDebounce = 0; doResize(); }, 100);
  }
});

// iOS keyboard: resize #app so flex compresses #term-area and the input bar
// stays visible above the keyboard. Terminal dimensions do NOT change --
// xterm.js keeps its cols/rows, bottom rows are hidden behind keyboard,
// user scrolls within xterm.js viewport to see content. No fit(), no
// scrollToBottom(), no PTY resize. Keyboard open/close is purely visual.
if (window.visualViewport) {
  const appEl = document.getElementById('app');
  let kbTimer = null;
  const onViewport = () => {
    appEl.style.height = window.visualViewport.height + 'px';
    window.scrollTo(0, 0);
    // After keyboard animation settles, refit terminal to match visible rows.
    // This updates xterm's scroll range so content can be scrolled fully.
    // No scrollToBottom, no PTY resize -- user scrolls manually.
    clearTimeout(kbTimer);
    kbTimer = setTimeout(() => {
      if (activeSession !== null && fits[activeSession]) {
        try { fits[activeSession].fit(); } catch (e) { clientLog('kb refit: ' + e.message); }
      }
    }, 400);
  };
  window.visualViewport.addEventListener('resize', onViewport);
  window.visualViewport.addEventListener('scroll', onViewport);
}

// ── iOS Prevention ──
// Prevent bounce scroll on non-scrollable areas
document.addEventListener('touchmove', e => {
  if (!e.target.closest('#term-area, #qbar, #msg, #input-bar, #img-btn, .xterm-viewport, #tab-switcher, #autocomplete, .switcher-item, #sp-list')) e.preventDefault();
}, { passive: false });

// Prevent ALL double-tap zoom (comprehensive)
document.addEventListener('dblclick', e => e.preventDefault(), { passive: false });

// Prevent pinch zoom -- narrow widths only (T14). The zoom lock exists
// because pinch-zoom competed with a cramped 390px layout; at tablet width
// the terminal is full-screen with a settable font, so zoom is an
// accessibility affordance rather than a source of accidental scale. The
// viewport meta no longer sets user-scalable=no either.
document.addEventListener('gesturestart', e => { if (!isWideLayout()) e.preventDefault(); }, { passive: false });
document.addEventListener('gesturechange', e => { if (!isWideLayout()) e.preventDefault(); }, { passive: false });
document.addEventListener('gestureend', e => { if (!isWideLayout()) e.preventDefault(); }, { passive: false });


// ── Send Button Fix (touch-based, not onclick) ──
const sendBtn = $('send');
sendBtn.addEventListener('touchend', e => {
  e.preventDefault();
  e.stopPropagation();
  sendMsg();
}, { passive: false });
sendBtn.addEventListener('click', e => {
  e.preventDefault();
  sendMsg();
});
// T09: a POINTER press on Send must not take focus from the compose box.
// mousedown's default action is to move focus; in hardware-keyboard mode
// losing it collapses the bar (:focus-within), so the layout moved under the
// pointer between mousedown and mouseup and the click was lost. Same guard
// the autocomplete rows use. Touch goes through touchend above.
sendBtn.addEventListener('mousedown', e => { e.preventDefault(); });

// ── Pull-up on tab count = new session ──
(function() {
  const btn = $('tab-count-btn');
  const countText = btn.querySelector('.count-text');
  const THRESHOLD = 40;
  let startY = 0, pulling = false, originalText = '';
  btn.addEventListener('touchstart', e => {
    startY = e.touches[0].clientY;
    pulling = false;
    originalText = countText.textContent;
  }, { passive: true });
  btn.addEventListener('touchmove', e => {
    const dy = startY - e.touches[0].clientY;
    if (dy > THRESHOLD && !pulling) {
      pulling = true;
      countText.textContent = '+';
      btn.style.borderColor = 'var(--accent)';
      btn.style.color = 'var(--accent-text)';
    } else if (dy <= THRESHOLD && pulling) {
      pulling = false;
      countText.textContent = originalText;
      btn.style.borderColor = '';
      btn.style.color = '';
    }
  }, { passive: true });
  btn.addEventListener('touchend', () => {
    if (pulling) { newSession(); pulling = false; }
    countText.textContent = originalText;
    btn.style.borderColor = '';
    btn.style.color = '';
  });
  btn.addEventListener('touchcancel', () => {
    pulling = false;
    countText.textContent = originalText;
    btn.style.borderColor = '';
    btn.style.color = '';
  });
})();

// Wake lock
if ('wakeLock' in navigator) {
  const lock = () => navigator.wakeLock.request('screen').catch(e => { console.warn('Wake lock:', e.message); });
  lock();
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') lock(); });
}

// E8 of W5: tab return -> request a fresh Snapshot to resync the grid
// renderer's state. Backgrounded tabs may miss frames; reconnect message
// is the cheapest way to re-seed without dropping the WS. Scoped to grid
// mode (xterm path has its own scrollback replay on reconnect).
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (RENDERER_MODE !== 'grid') return;
  if (activeSession === null) return;
  if (!ws || ws.readyState !== 1) return;
  queueSend({ type: 'connect', session: activeSession, renderer: 'grid' });
});
