// PM2 definition for the P2 soak watch.
//
// The task this closes was recorded as "Not running", so the wiring ships
// with the tool rather than being improvised at the moment it matters:
// `npm run watch:start` is the whole procedure.
//
// STARTING IT belongs with the flip to herdr, not before. Watching an idle
// instance reproduces exactly the measurement this replaces -- four days of a
// clean log on a process nobody was using.
//
// After starting it, `pm2 save` so it comes back with the rest after a
// reboot. A week-long soak that silently ends at the first restart is the
// other half of the same failure.
module.exports = {
  apps: [{
    name: 'claude-mobile-crashwatch',
    script: 'scripts/crash-watch.js',
    // 3456 is the instance the operator actually uses; point this at whichever
    // one is running the herdr backend at the time.
    args: '--port 3456 --interval 60',
    cwd: __dirname,
    autorestart: true,
    // The watch losing its own place would be invisible, so restarts are
    // slowed enough to be noticed in `pm2 list` rather than spinning.
    min_uptime: 60000,
    max_restarts: 10,
    restart_delay: 5000,
    time: true,
  }],
};
