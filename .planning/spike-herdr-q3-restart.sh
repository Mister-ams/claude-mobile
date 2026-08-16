#!/usr/bin/env bash
# spike-herdr-q3-restart.sh -- Wave 1 / S1, QUESTION 3: restart restore.
#
# Kills the herdr server and restarts it, then compares before/after:
#   - does pane shape come back (workspace / tab / pane / cwd / layout)?
#   - does pane_history restore scrollback?
#   - does resume_agents_on_restore genuinely re-attach the Claude
#     CONVERSATION, or merely put a fresh shell in the same directory?
#
# The last one is the headline claim over dtach, so it is checked against
# the actual pane contents, not against config intent.
#
# Run INSIDE WSL:  bash spike-herdr-q3-restart.sh <pane_to_track>
set -uo pipefail

HERDR=/root/.local/bin/herdr
SPIKE=/tmp/herdr-spike
PANE="${1:-w6:p1}"
cd "$SPIKE"

echo "===== Q3: RESTART RESTORE ====="
echo
echo "--- config in force ---"
cat /root/.config/herdr/config.toml

echo
echo "--- BEFORE: snapshot ---"
node spike-herdr-client.js session.snapshot '{}' > q3-before-snapshot.json
python3 - <<'PY'
import json
d = json.load(open('/tmp/herdr-spike/q3-before-snapshot.json'))['snapshot']
print('workspaces:', [(w['workspace_id'], w.get('label')) for w in d['workspaces']])
print('panes:', [(p['pane_id'], p.get('cwd'), p.get('agent'), p.get('agent_status')) for p in d['panes']])
print('agents:', [(a['pane_id'], a.get('agent'), a.get('agent_status')) for a in d.get('agents', [])])
PY

echo
echo "--- BEFORE: tracked pane $PANE screen tail ---"
node spike-herdr-step.js read "$PANE" 12 || true

echo
echo "--- BEFORE: pane process tree ---"
node spike-herdr-client.js pane.process_info "{\"pane_id\":\"$PANE\"}" || true

echo
echo "--- persisted restore state (session.json) ---"
python3 - <<'PY'
import json
d = json.load(open('/root/.config/herdr/session.json'))
blob = json.dumps(d)
print('version:', d.get('version'))
print('workspace count:', len(d.get('workspaces', [])))
for key in ['agent', 'session_id', 'session_ref', 'resume', 'command', 'argv', 'claude']:
    print(f'  occurrences of {key!r}: {blob.count(key)}')
PY

echo
echo "===== STOPPING SERVER ====="
$HERDR server stop 2>&1 || true
sleep 3
echo "processes still alive:"
ps -eo pid,cmd | grep -E "[h]erdr" || echo "  (none -- server is down)"

echo
echo "===== RESTARTING SERVER ====="
setsid nohup $HERDR server </dev/null > "$SPIKE/server-restart.out" 2>&1 &
disown
sleep 6
$HERDR status 2>&1 | sed -n '1,14p'

echo
echo "--- AFTER: snapshot ---"
node spike-herdr-client.js session.snapshot '{}' > q3-after-snapshot.json
python3 - <<'PY'
import json
d = json.load(open('/tmp/herdr-spike/q3-after-snapshot.json'))['snapshot']
print('workspaces:', [(w['workspace_id'], w.get('label')) for w in d['workspaces']])
print('panes:', [(p['pane_id'], p.get('cwd'), p.get('agent'), p.get('agent_status')) for p in d['panes']])
print('agents:', [(a['pane_id'], a.get('agent'), a.get('agent_status')) for a in d.get('agents', [])])
PY

echo
echo "--- AFTER: tracked pane $PANE screen tail (scrollback restored?) ---"
node spike-herdr-step.js read "$PANE" 15 || true

echo
echo "--- AFTER: pane process tree (is claude running again?) ---"
node spike-herdr-client.js pane.process_info "{\"pane_id\":\"$PANE\"}" || true

echo
echo "===== DIFF SUMMARY ====="
python3 - <<'PY'
import json
b = json.load(open('/tmp/herdr-spike/q3-before-snapshot.json'))['snapshot']
a = json.load(open('/tmp/herdr-spike/q3-after-snapshot.json'))['snapshot']
bw = {w['workspace_id']: w.get('label') for w in b['workspaces']}
aw = {w['workspace_id']: w.get('label') for w in a['workspaces']}
print('workspaces before:', len(bw), ' after:', len(aw), ' identical ids:', set(bw) == set(aw))
bp = {p['pane_id']: p.get('cwd') for p in b['panes']}
ap = {p['pane_id']: p.get('cwd') for p in a['panes']}
print('panes before:', len(bp), ' after:', len(ap), ' identical ids:', set(bp) == set(ap))
print('cwd preserved for all shared panes:',
      all(bp[k] == ap[k] for k in set(bp) & set(ap)))
ba = {x['pane_id']: x.get('agent') for x in b.get('agents', [])}
aa = {x['pane_id']: x.get('agent') for x in a.get('agents', [])}
print('agents before:', ba)
print('agents after: ', aa)
PY
