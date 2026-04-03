# HANDOVER -- Claude Mobile

Session: 2026-04-03

## Completed This Session

- Full code review (4 agents: F1-F4) of claude-mobile codebase (4,476 LOC) -- 38 unique findings (13 must-fix, 25 should-fix)
- v3.1.6: 38 fixes across 5 waves (async createSession, E2E crypto improvements, 28 empty catches replaced with audit logging, dep update path-to-regexp GHSA-37ch-88jc-xwx2) -- commit a1b6afe
- Hotfix v3.1.7: confirm() dialog blocked JS on iOS killing WS 2.4s after auth; reverted strict sequential client replay check (caused message drops on iOS) -- commits ba5d066, 01b6da2
- Re-review (4 agents): 10 remaining findings (3 regressions from v3.1.6), all fixed -- commit 01b6da2
- Architecture review (dt.architect): 10 findings. Skipped monolith extraction (#1, #2). Executed quick wins + CSS extraction
- v3.2.0: renamed client `sessions` to `sessionList`, normalized auth responses (verified->success), extracted checkRateLimits helper, fixed stale tmux comment, extracted 503 lines CSS to public/style.css -- commits 57eb1f9, cee97b9
- User reported "typing works but enter doesn't push to terminal" on v3.2.0 -- investigated, input IS reaching server (audit log confirms). Likely stale Claude process in recovered session, not a code bug

## Key Decisions

- Client strict sequential replay check (!==) breaks iOS Safari -- reverted to gap-tolerant (<=). Server keeps strict. Asymmetry is intentional and safe
- confirm() dialogs on iOS block JS and cause WebSocket death -- never use blocking dialogs after auth
- secureSend plaintext fallback after E2E was active now drops message instead of sending unencrypted
- decrypt failure auto-reconnect capped at 3 cycles to prevent infinite loops
- Architecture: server.js monolith (1836 LOC) and login/lock screen merge deferred -- not worth the risk for a 4K LOC project

## Next Action

Deferred architecture items: T07 (merge login/lock screen into single auth UI) and T08 (extract setup pages from server.js into public/setup.html). Then investigate the "enter doesn't push" issue if it persists.

## State

- Branch: master
- Last commit: cee97b9 (refactor: architecture cleanup Wave 1 -- extract CSS to style.css)
- Tag: v3.1.5 at 6fb7873 (v3.1.6/v3.1.7/v3.2.0 untagged)
- Uncommitted: none
- Planning: .planning/plan-architecture-cleanup.md, .planning/plan-v3.1.6-review-fixes.md (completed, unarchived)

## Context Pointers

- v4 tech-design: .planning/tech-design-v4-thin-viewer.md (tmux/dtach mismatch -- blocked)
- Architecture cleanup plan: .planning/plan-architecture-cleanup.md
- Review fixes plan: .planning/plan-v3.1.6-review-fixes.md
- MEMORY: project_otg.md (version history, stack, all features)
- CLAUDE.md: architecture, security tiers, gotchas
