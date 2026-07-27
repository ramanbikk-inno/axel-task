# ADR-004: Session Idle Timeout Enforced at Refresh

**Date:** 2026-07-27  
**Status:** Accepted  
**Feature:** Cross-cutting (Epic-01 §9 "Sessions should expire after reasonable inactivity")

## Context

The spec's business rules state sessions should expire after reasonable inactivity, and leaves the exact duration as an open question for the client (Q-01.07). Before this change, nothing in the codebase read `auth_sessions.last_used_at` — it was written on login and on refresh, but no code path ever compared it to the current time. A session was bounded only by:

- The access token's 15-minute lifetime (`JWT_ACCESS_TTL`), which the client silently renews via refresh.
- The refresh token's 7-day lifetime (`JWT_REFRESH_TTL`), which does not depend on activity at all.
- The 1-hour hard cap on impersonation sessions specifically (`auth_sessions.expires_at`).

So an abandoned session — a browser tab left open, a stolen refresh token — stayed usable for up to 7 days regardless of whether anyone had touched it in the meantime.

## Decision

**A session idle for longer than `SESSION_IDLE_TIMEOUT` (default `24h`) is rejected at its next refresh attempt.**

1. `lastUsedAt` is compared to the current time inside `AuthService.refresh()`, immediately after the existing hard-cap check. If the gap exceeds the configured timeout, the session is revoked (`revokedReason: 'idle-timeout'`) and the refresh is rejected with the same `REFRESH_TOKEN_INVALID` code the other refresh failures already use.

2. The check lives in `refresh()`, not in `SessionValidatorService` (which re-validates every access-token-guarded request). A currently-valid access token is at most 15 minutes old by construction, so it can never itself be evidence of a 24-hour idle gap — the only place idle time actually accumulates unnoticed is between one refresh and the next.

3. `SESSION_IDLE_TIMEOUT` is a duration string (`'24h'`, `'2h'`, `'30m'`), parsed by the same `durationToSeconds` helper already used for `JWT_ACCESS_TTL` and `JWT_REFRESH_TTL`, rather than a bare number of hours — matching the existing convention instead of introducing a second one.

4. Default is 24 hours. Q-01.07 leaves the exact figure to the client; 24h was chosen as a middle ground — tight enough to bound a stolen or abandoned session meaningfully, loose enough that a user checking in once a day is never logged out for reasons they'd experience as arbitrary. It is a config value specifically so the client can revisit it without a code change.

## Consequences

### Positive
- Closes the "session never actually expires from inactivity" gap called out in the spec's business rules.
- A stolen refresh token has a bounded window of usefulness even if the legitimate user never logs in again to trigger the existing reuse-detection path.
- Configurable without a deploy: `SESSION_IDLE_TIMEOUT=2h` for a stricter posture, or a longer value if 24h proves too aggressive in practice.

### Negative
- A user who genuinely doesn't touch the app for 24+ hours is signed out and must log in again, even though nothing suspicious happened. This is the intended trade-off of an idle timeout, not a defect, but it is a UX cost.
- Adds one more thing to reason about when debugging an unexpected 401 on refresh, alongside the existing hard-cap and reuse-detection checks.

### Neutral
- `lastUsedAt` continues to be written exactly where it already was (login, refresh); nothing about how it's populated changed, only that it is now read.
- The impersonation hard cap (`expires_at`, 1 hour) and the idle timeout (`last_used_at`, 24h default) are independent checks. An impersonation session hits its hard cap first in every realistic case, since 1 hour is well inside the default idle window.

## Verification

Unit tests in `test/integration/auth.refresh.spec.ts` pin the boundary (one second inside vs. past the window), a configured override, and the defensive `lastUsedAt: null` branch. An e2e test in `test/auth-refresh.e2e-spec.ts` exercises the same boundary through the real HTTP surface using the test clock. Mutation-checked: removing the check fails both the "past the window" unit test and its e2e equivalent.

## References
- [AuthService.refresh](../../src/modules/auth/auth.service.ts)
- [env.validation.ts](../../src/shared/config/env.validation.ts)
- [durationToSeconds](../../src/shared/config/duration.ts)
