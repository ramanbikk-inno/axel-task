# ADR-002: Birth Date Lives on the Player Profile, Not on `users`

**Date:** 2026-07-26  
**Status:** Accepted  
**Feature:** US-01.03 (Registration), US-01.04 (Profile Management)

## Context

`POST /auth/register` collects `birthDate` because self-registration is gated on a minimum age. Once that check passes, the date has to be stored somewhere: a trainer's roster shows each player's age, and the registrant is never asked for it again.

Two candidate homes existed:

1. A `birth_date` column on `users`, alongside the account.
2. The `birth_date` column that already exists on `player_profiles`.

The second was already in use. `POST /join/:code/register` — the ShareLink registration path — has always written the registrant's date to their self profile at account creation, and every child profile stores its date there too. So option 2 meant one home for the fact; option 1 meant two, for the same person, with the account-holder's date duplicated across both.

The complication is timing. Before this change, `POST /auth/register` created only the `users` row. The account holder's own `PlayerProfile` was created later — on first join, or on first profile edit — which is why the collected date had nowhere to go and was silently dropped.

## Decision

**Store the birth date on the player's self profile (`player_profiles.birth_date`), and create that profile during registration.**

1. `POST /auth/register` creates the `users` row, the self profile (`isChild: false`) carrying `birthDate`, and the email-verification token — in one transaction. This is the same point in the flow at which the ShareLink path already created the profile.

2. `PATCH /profile/me/player` accepts `birthDate` so a mistyped date can be corrected, and re-runs the same age floor. Without that, the rule would hold only at signup and a single PATCH would undo it.

3. `birthDate` is **not** nullable on the edit. It uses `IsOptionalNotNull`, unlike the clearable fields beside it, because a minimum-age check has nothing to compare against a null.

4. No `users.birth_date` column is added.

## Consequences

### Positive

- **One home for one fact.** No synchronisation burden and no possibility of the two copies disagreeing.
- **Registration paths converge.** `/auth/register` and `/join/:code/register` now produce the same shape, rather than one keeping the field and the other discarding it.
- **The trainer roster works for self-registered players.** It reads the profile, which is why those players previously showed `birthDate: null`.
- **Registration is atomic.** Bundling the three writes closed a pre-existing hazard: a failure between them left an account that could never verify itself.

### Negative

- **A registered-but-not-yet-joined account now has a self profile where it previously had none.** That profile was always going to be created on the next meaningful action; only the timing moved. One existing test asserted `PlayerProfile.count() === 0` to mean "no child was stored" — a proxy that was only ever true while the registrant had no profile, and which had to be corrected to count children specifically.
- **The date is reachable only through the profile.** Anything wanting a user's age must resolve the self profile first; there is no column on `users` to read directly.

### Neutral

- A child's date lives on the child's own profile row, owned by the parent. `updateSelfProfile` scopes its lookup to `isChild: false`, which is what keeps a child's row out of reach of a self-profile write.
- Erasure sweeps the account holder's profile as well as each child's, so a re-registered address gets a fresh date rather than inheriting the anonymised row's.

## References

- [AuthService.register](../../src/modules/auth/auth.service.ts)
- [ProfileService.updatePlayer](../../src/modules/profile/profile.service.ts)
- [UpdatePlayerProfileDto](../../src/modules/profile/dto/profile.dto.ts)
- [IsOptionalNotNull](../../src/shared/validation/presence.ts)
- [ADR-003](ADR-003-password-hashing-outside-transactions.md) — the transaction this registration now runs in
