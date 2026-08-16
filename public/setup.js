(async function() {
  // Fetch setup status
  let status;
  try {
    const r = await fetch('/api/setup/status');
    status = await r.json();
  } catch (e) {
    document.getElementById('view-loading').innerHTML =
      '<p class="subtitle err">Failed to load setup status.</p>';
    return;
  }

  document.getElementById('view-loading').classList.add('hidden');

  if (status.setupComplete) {
    // Show re-enrollment view
    const view = document.getElementById('view-complete');
    view.classList.remove('hidden');
    document.getElementById('fp').textContent =
      (status.fingerprint || '').slice(0, 16) + '...';

    // Reset button
    document.getElementById('btn-reset').addEventListener('click', async () => {
      // Sends a JSON body even though none is needed. The server requires
      // application/json on these endpoints, and that requirement is what
      // makes them non-"simple" requests -- un-forgeable by a cross-origin
      // page, which cannot set this content type without a preflight. A
      // bodyless POST would qualify as a simple request.
      const r = await fetch('/api/totp/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      const d = await r.json();
      const result = document.getElementById('reset-result');
      if (d.error) {
        result.className = 'err';
        result.textContent = d.error;
        return;
      }
      if (d.qr) {
        const qrEl = document.getElementById('reset-qr');
        qrEl.innerHTML = '<img src="' + d.qr + '" width="200" height="200">';
        qrEl.classList.remove('hidden');
      }
      if (d.secret) {
        const secEl = document.getElementById('reset-secret');
        secEl.textContent = d.secret;
        secEl.classList.remove('hidden');
      }
      document.getElementById('reset-verify').classList.remove('hidden');
    });

    // Verify reset
    async function verifyReset() {
      const code = document.getElementById('reset-code').value.trim();
      if (code.length !== 6) return;
      const r = await fetch('/api/totp/verify-reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code })
      });
      const d = await r.json();
      const result = document.getElementById('reset-result');
      result.className = d.verified ? 'ok' : 'err';
      result.textContent = d.verified
        ? 'Re-enrollment complete. Your new authenticator is active.'
        : 'Code incorrect. Try again.';
    }
    document.getElementById('btn-verify-reset').addEventListener('click', verifyReset);
    document.getElementById('reset-code').addEventListener('keydown', e => {
      if (e.key === 'Enter') verifyReset();
    });

  } else {
    // Show initial setup view
    const view = document.getElementById('view-initial');
    view.classList.remove('hidden');

    // Auto-init: fetch QR
    try {
      // JSON body for the same reason as /api/totp/reset above.
      const r = await fetch('/api/setup/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      const d = await r.json();
      if (d.qr) {
        document.getElementById('init-qr').innerHTML =
          '<img src="' + d.qr + '" width="200" height="200">';
      }
      if (d.secret) {
        document.getElementById('init-secret').textContent = d.secret;
      }
    } catch (e) {
      document.getElementById('init-qr').textContent = 'Failed to generate QR code.';
    }

    // Verify initial setup
    async function verifyInit() {
      const code = document.getElementById('init-code').value.trim();
      if (code.length !== 6) return;
      const r = await fetch('/api/setup/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code })
      });
      const d = await r.json();
      const result = document.getElementById('init-result');
      result.className = d.verified ? 'ok' : 'err';
      result.textContent = d.verified
        ? 'Setup complete. Open the tunnel URL on your phone.'
        : 'Code incorrect. Try again.';
      if (d.verified) setTimeout(() => location.reload(), 2000);
    }
    document.getElementById('btn-verify-init').addEventListener('click', verifyInit);
    document.getElementById('init-code').addEventListener('keydown', e => {
      if (e.key === 'Enter') verifyInit();
    });
  }
})();
