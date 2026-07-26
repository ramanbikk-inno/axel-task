# ADR-003: Password Hashing Happens Outside Database Transactions

**Date:** 2026-07-26  
**Status:** Accepted  
**Feature:** Cross-cutting (US-01.01 Registration, US-01.07 Coach Invites, US-01.02 ShareLink Join)

## Context

argon2id is deliberately expensive. At the configured parameters (`ARGON_MEMORY_KIB=19456`, `ARGON_TIME_COST=2`, `ARGON_PARALLELISM=1`) a single hash measures **~30–50 ms of CPU-bound work**. That cost is the point — it is what makes an offline attack on a stolen hash impractical.

`AuthService.createUnverifiedAccount` is the shared helper that creates an unverified account and its email-verification token. It hashed the incoming password as its first statement. All three of its callers invoke it **inside a transaction**:

| Caller | Transaction also holds |
| --- | --- |
| `AuthService.register` | nothing beyond the three writes |
| `CoachesService.accept` | `SELECT … FOR UPDATE` on the coach invite |
| `EnrollmentService.registerViaShareLink` | `SELECT … FOR UPDATE` on the ShareLink |

So every account creation ran argon2id on a checked-out pooled connection that had no work to do. In the two ShareLink flows it ran while holding a row lock, which serialised everyone redeeming the same code behind one hash after another.

Separately, `AuthService.register` hashed only *after* its existence check, and only on the path where the address turned out to be free. `POST /auth/register` returns an identical generic `201` whether or not the address is registered — but a taken address answered ~40 ms sooner, which is a measurable side channel disclosing exactly what the generic response exists to hide.

## Decision

**Hash before opening the transaction. The helper takes a hash, never a password.**

1. `createUnverifiedAccount` and `createUnverifiedPlayer` accept `passwordHash: string` instead of `password: string`. They no longer depend on `PasswordService` for this path at all.

   This is the mechanism, not merely three separate hoists. The shared helper is what placed argon2id inside all three transactions, so making it *incapable* of hashing means the compiler locates every caller and no future caller can reintroduce the problem.

2. Each caller hashes first, then opens its transaction. `CoachesModule` and `EnrollmentModule` import `CryptoModule` for the `PasswordService` dependency this requires.

3. In `register`, the hash moves above the **existence check**, not merely above the transaction, so both outcomes pay the same cost and the timing channel closes. `login` already does this deliberately — it verifies against a dummy hash when no user is found, so an unknown address takes as long as a known one.

4. The two ShareLink flows compute the hash **unconditionally** and discard it when an existing account is re-homed instead. Which branch applies is only knowable once the link row is locked, and a wasted hash off the connection is cheaper than a needed one on it.

## Consequences

### Positive

- **Pooled connections are no longer held for CPU work.** Under concurrent registration the pool is the scarce resource; this removes ~40 ms of occupancy per account created.
- **Redemptions of one link no longer serialise on hashing.** The row lock is held only for the writes that need it.
- **The registration timing channel is closed.** A taken address and a free one now cost the same.
- **The invariant is enforced by types.** `passwordHash` in the signature states the contract; passing a plaintext password is a compile error.

### Negative

- **A rejected coach invite or duplicate ShareLink registration burns one hash.** Bounded and off the connection. Registration endpoints must hash on the success path anyway, so rate limiting already has to account for argon2id per request; this is not a new vector.
- **Callers must remember to hash.** Mitigated by the parameter name and by the type: the field cannot be satisfied with a password.

### Neutral

- `family.service.createChildLogin` already hashed before opening its transaction, so this makes the codebase consistent rather than introducing a new pattern.
- The other hashing call sites — `resetPassword`, `changePassword`, `setupPassword`, the login rehash, and the super-admin seed — never ran inside a transaction and are unchanged.

## Verification

An audit of all ten `passwords.hash` call sites in `src/` confirms none remains inside a transaction. Three tests pin the invariant:

| Test | Kills |
| --- | --- |
| ordering: `['hash', 'transaction']` | argon2id moving back inside the transaction |
| hash runs when the address is taken | the hash sliding below the existence check |
| `createUnverifiedAccount` never calls `hash` | the shared helper hashing again, for all three callers at once |

## References

- [AuthService.createUnverifiedAccount](../../src/modules/auth/auth.service.ts)
- [CoachesService.accept](../../src/modules/coaches/coaches.service.ts)
- [EnrollmentService.registerViaShareLink](../../src/modules/enrollment/enrollment.service.ts)
- [PasswordService](../../src/shared/crypto/password.service.ts)
- [ADR-002](ADR-002-birth-date-on-player-profile.md) — why registration became transactional
