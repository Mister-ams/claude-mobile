# HANDOVER -- Claude Mobile

Session: 2026-03-24

## Completed This Session

- Cold-started project from MEMORY only (no prior HANDOVER.md, not in project-index.md)
- Fixed doc staleness: added claude-mobile to project-index.md, archived scrollback-and-dtach planning files
- Corrected CLAUDE.md commit ref
- Ran full dt.review (4 agents) on v3.1.3 codebase (4252 LOC) -- 31 findings (19 must-fix, 12 should-fix)
- Planned and executed 19 must-fix findings: plan-v3.1.3-hardening.md, 18 tasks, 4 waves, 2 sprints. Tagged v3.1.4 (fccc5fc)
- Planned and executed 12 should-fix findings: plan-v3.1.4-should-fix.md, 12 tasks, 3 waves, 1 sprint. Tagged v3.1.5 (6fb7873)
- Fixed input clipping bug (6f59c55): text and \r sent as two separate pty writes 50ms apart caused race in pipeline (client->WS->server->wsl.exe->dtach->Claude TUI). Changed to single atomic qsend(t + '\r') in index.html:1790
- All pushed to GitHub. PM2 tested locally -- stable, 4 sessions recovered, clipping confirmed fixed by user

## Key Decisions

- 18 empty catch blocks in server.js silently swallowed errors -- all fixed with structured error handling
- secureReceive accepted sequence gaps (counter advancement attack) -- fixed to strict sequential
- secureSend had no type filter on plaintext fallback -- restricted to handshake-only messages pre-encryption
- JS strings are UTF-16 not raw bytes -- scrollback truncation targets surrogate pairs, not UTF-8 continuation bytes
- Input clipping was a pty pipeline race -- text and Enter as separate writes had variable latency

## Next Action

v4-thin-viewer Wave 1 kickoff (0/4 waves complete).
Active spec at .planning/plan-v4-thin-viewer.md.

## State

- Branch: master
- Last commit: 6f59c55 (fix: send text and Enter as single atomic pty write)
- Tag: v3.1.5 at 6fb7873
- Uncommitted: none (planning artifacts are untracked/gitignored)
- All changes pushed to origin/master

## Context Pointers

- Audit findings: .planning/audit-v3.1.3-review.md
- Must-fix plan: .planning/plan-v3.1.3-hardening.md
- Should-fix plan: .planning/plan-v3.1.4-should-fix.md
- v4 thin viewer plan: .planning/plan-v4-thin-viewer.md
- CLAUDE.md: project architecture, security tiers, gotchas
- MEMORY: project_otg.md (version history, stack, all features)
