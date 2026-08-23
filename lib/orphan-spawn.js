/**
 * Spawn a process that survives PM2 restarting THIS one.
 *
 * PM2 restarts by tree-killing (`taskkill /T` on Windows), which walks the
 * parent-PID chain. Anything we spawn normally dies with us, and `detached:
 * true` does NOT change that: it gives the child its own console and stops it
 * dying WITH the parent, but the parent-PID record stays and taskkill /T walks
 * exactly that record. Both measured, 2026-08-23; both died.
 *
 * So the work is launched through a throwaway node process that exits
 * immediately. By the time PM2 enumerates our descendants the real process has
 * no living parent and is not one of them.
 *
 * A `cmd /c start` orphans just as well and is one line shorter. It is not
 * used, because it puts a shell back in the launch path that T23 deliberately
 * removed: every argument here reaches the target as an argv entry, so a path
 * containing a backtick, `&` or a space is data rather than syntax.
 *
 * Two callers need this and they need it for the same reason:
 *   - the herdr backend, whose session server must outlive a restart
 *   - the updater, which runs `pm2 restart` and would otherwise tree-kill
 *     itself partway through `npm ci`, leaving node_modules half-deleted
 */

const { spawn } = require('child_process');

// The payload arrives base64-encoded so no quote survives to be re-parsed by
// Windows argv escaping on the way in.
const LAUNCHER =
  "const {spawn}=require('child_process');" +
  "const p=JSON.parse(Buffer.from(process.argv[1],'base64').toString());" +
  "const c=spawn(p.command,p.args,{cwd:p.cwd||undefined,env:process.env," +
  "detached:true,stdio:'ignore',windowsHide:true});" +
  "c.unref();process.exit(0);";

/**
 * @param {object} o
 * @param {string} o.command  executable to run
 * @param {string[]} [o.args]  argv, as an array -- never a joined string
 * @param {string} [o.cwd]
 * @param {object} [o.env]  environment for the launcher, inherited by the
 *                          target. Pass the whitelist, not process.env: the
 *                          orphan is what the eventual work inherits from.
 */
function orphanSpawn({ command, args = [], cwd, env }) {
  const payload = Buffer.from(JSON.stringify({ command, args, cwd })).toString('base64');
  const launcher = spawn(process.execPath, ['-e', LAUNCHER, payload], {
    detached: true, stdio: 'ignore', windowsHide: true,
    ...(env ? { env } : {}),
  });
  launcher.unref();
}

module.exports = { orphanSpawn };
