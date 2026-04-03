# HANDOVER -- Claude Mobile

Session: 2026-04-03

## Completed This Session

- v3.2.1: T07 merged login/lock into single #auth-screen (f8b950d), T08 extracted setup pages to public/setup.html + /api/setup/status endpoint (9d7984b). server.js 1836->1769 LOC
- All architecture cleanup items from plan-architecture-cleanup.md now complete

### Previous Session (same day, carried forward)

- Full code review (4 agents) -- 38 findings (13 must-fix, 25 should-fix)
- v3.1.6: 38 fixes (async createSession, E2E hardening, 28 empty catches, dep update)
- Hotfix v3.1.7: confirm() dialog killed iOS WS, reverted strict sequential client replay
- Re-review: 10 findings (3 regressions), all fixed
- Architecture review (dt.architect): 10 findings, monolith extraction skipped
- v3.2.0: CSS extracted to style.css, sessionList rename, auth response normalization, checkRateLimits helper

## Key Decisions

- iOS confirm() blocks JS killing WS ~2.4s after auth -- never use blocking dialogs
- Strict sequential client replay (!==) breaks iOS Safari -- gap-tolerant (<=) is correct
- secureSend drops plaintext after E2E active (security fix)
- Decrypt reconnect capped at 3 cycles (prevents infinite loop)
- Monolith extraction deferred -- not worth risk for 4K LOC project

## Next Action

Reconcile v4 tech-design tmux/dtach mismatch, then v4-thin-viewer Wave 0 kickoff (T01: ANSI-to-HTML converter, T02: ANSI color CSS classes).

## State

- Branch: master
- Last commit: f8b950d (refactor(T07): merge login/lock screen into single auth UI)
- Tag: v3.1.5 at 6fb7873 (v3.1.6-v3.2.1 untagged)
- Uncommitted: none
- Planning: .planning/plan-architecture-cleanup.md (all tasks complete)

## Context Pointers

- v4 tech-design: .planning/tech-design-v4-thin-viewer.md (tmux/dtach mismatch -- blocked)
- Architecture cleanup plan: .planning/plan-architecture-cleanup.md
- MEMORY: project_otg.md (version history, stack, all features)
- CLAUDE.md: architecture, security tiers, gotchas
