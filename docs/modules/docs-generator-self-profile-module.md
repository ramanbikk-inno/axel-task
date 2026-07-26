# Self-Profile & Registration Age Rules (US-01.01, US-01.03, US-01.04)

## Overview

The "self profile" is the `PlayerProfile` row an account holder owns for themselves — `isChild: false`, `ownerUserId` = their user id. It is distinct from the child profiles the same account may own.

This document covers three rules that operate on it:

1. **A birth date is collected at registration and kept** on the self profile.
2. **A minimum age gates any account held in someone's own name** (`MIN_SELF_REGISTRATION_AGE`).
3. **A child login may not touch the self-profile routes**, because a child has no self profile.

See [ADR-002](../adrs/ADR-002-birth-date-on-player-profile.md) for why the date lives on the profile rather than on `users`.

## Configuration

| Variable | Type | Default | Meaning |
| --- | --- | --- | --- |
| `MIN_SELF_REGISTRATION_AGE` | integer, 0–120 | `18` | Minimum age to hold an account in your own name. Below it, a player belongs to a parent's account as a child profile. |

Validated by the zod env schema, so an out-of-range or non-numeric value fails startup rather than silently defaulting. The default is exported as `MIN_SELF_REGISTRATION_AGE_DEFAULT` and used both as the schema default and as the service's fallback, so the two cannot drift apart.

Setting it to `0` admits anyone born in the past. It does not disable the check — a future date is still rejected.

## Endpoints

### `POST /auth/register`

Creates an unverified account, its self profile, and its email-verification token in **one transaction**.

#### Body

| Field | Required | Notes |
| --- | --- | --- |
| `email` | yes | |
| `password` | yes | Strong-password policy |
| `birthDate` | **yes** | `YYYY-MM-DD`. Required, not optional — a minimum-age rule cannot be enforced on a field callers may omit. |
| `firstName` | no | 1–100 chars |
| `lastName` | no | 1–100 chars |
| `phone` | no | Loose phone validation |

#### Responses

| Status | Condition |
| --- | --- |
| `201` | Always, on success **and** when the address is already registered — the response is deliberately identical. |
| `403` `UNDERAGE_SELF_REGISTRATION` | Younger than `MIN_SELF_REGISTRATION_AGE`. The message names the threshold so the UI need not hardcode it. |
| `422` `VALIDATION_ERROR` | `birthDate` is not a `YYYY-MM-DD` calendar date — a time component, a non-existent day (`2008-02-30`), or anything unparseable. Rejected by the DTO. |
| `400` `VALIDATION_ERROR` | `birthDate` is a well-formed date **in the future**. Rejected by the service, after the DTO has accepted it. |

The generic `201` is enumeration safety: an unauthenticated caller must not learn which addresses hold accounts. Two consequences follow, both deliberate:

- The age check runs **before** the existence check, so a refusal cannot double as an existence oracle.
- A unique-violation on `uq_users_email` — reachable when two concurrent registrations of one address both pass the existence read — is swallowed to the same `201`. It is narrowed to that specific index, so an unrelated unique collision still fails loudly.

The verification email is sent **after** the transaction commits: the mail provider is not transactional, and an outage there must not undo an account that already exists.

### `PATCH /profile/me/player`

Updates the account holder's own trainee profile. Creates one if the account predates registration-time profile creation.

**Guards:** `JwtAuthGuard`, `RolesGuard` + `@Roles(Role.PlayerParent)`, **`NotAChildGuard`**

**Body** — all fields optional; three-state PATCH semantics apply (see below).

| Field | Clearable with `null`? | Notes |
| --- | --- | --- |
| `displayName` | **no** | The one profile field that must always hold a value |
| `birthDate` | **no** | The age rule has nothing to check against a null |
| `school` | yes | |
| `jerseyNumber` | yes | |
| `gender` | yes | |

#### Responses

| Status | Condition |
| --- | --- |
| `200` | Updated profile |
| `403` `CHILD_ACTION_NOT_ALLOWED` | Caller is a child account |
| `403` `UNDERAGE_SELF_REGISTRATION` | Supplied `birthDate` is below the floor |
| `422` `VALIDATION_ERROR` | Malformed `birthDate`, or `null` for a non-clearable field |
| `400` `VALIDATION_ERROR` | `birthDate` is well-formed but in the future |

Supplying `birthDate` re-runs the same floor as registration. Without that, the age rule would hold only at signup and one PATCH would undo it.

### `GET /profile/me`

Returns `player.birthDate` alongside the rest of the self profile. `player` is `null` for accounts with no self profile.

### Why a bad date is sometimes 422 and sometimes 400

Both carry `VALIDATION_ERROR`, but they are raised in different layers and the status differs:

- **`422`** — the global `ValidationPipe` is configured with `errorHttpStatusCode: UNPROCESSABLE_ENTITY`, so every DTO-level rejection (`IsCalendarDate`, `IsOptionalNotNull`) is a 422.
- **`400`** — `assertOldEnoughForOwnAccount` throws `BadRequestException` for a future date. `2030-01-01` is a perfectly well-formed calendar date, so the DTO accepts it and only the service can tell it is impossible.

A future date is deliberately *not* a `403`: a 403 would say the date was understood and refused on age, when in fact it was not understood at all.

## Three-state PATCH semantics

A PATCH field has three distinguishable states, and `class-validator` does not separate the last two by default:

| Sent | Means |
| --- | --- |
| key absent | leave unchanged |
| `null` | clear the field |
| a value | set the field |

`@IsOptional()` skips **every other validator** on `null` as well as `undefined`. On a field backed by a `NOT NULL` column that means an explicit `null` passes validation, reaches the database, and surfaces as a `500`.

`IsOptionalNotNull` (`src/shared/validation/presence.ts`) is `@ValidateIf((_, value) => value !== undefined)` — the key may be omitted, but if present it must be valid, and `null` is not. Use `@IsOptional()` where `null` is how a caller clears a field, and `IsOptionalNotNull` where it is not.

Applied to: `UpdatePlayerProfileDto.displayName`/`birthDate`, `UpdateChildDto.displayName`/`birthDate`/`gender`, `UpdateTrainerProfileDto.businessName`, `UpdateCoachProfileDto.publicVisible`.

## Child accounts and the self-profile routes

A child login is a `User` with `Role.PlayerParent` and `isChild` set on the resolved `Principal`. The role is shared with real parents, so **`@Roles(Role.PlayerParent)` admits a child by construction** — role checks alone are never sufficient to exclude one.

A child has no self profile. Theirs is the child row their parent owns, edited through `/players/children/:id`. So a route treating "no self profile" as "create one" will mint a *second*, non-child profile owned by the child user — and because that profile now carries a birth date, the minimum-age floor forces the new row to assert the child is an adult. The result is two contradictory records for one person, with `findSelfProfile` resolving to the adult one.

`PATCH /profile/me/player` is closed in **two independent places**, each sufficient on its own:

1. `NotAChildGuard` on the route, matching every family-management endpoint.
2. An `isChild` check in `ProfileService.updatePlayer`, because the create fallback is the actual hazard and a route decorator is easy to drop in a later refactor.

What a child login may still do, each covered by a test: read its own account (`GET /profile/me`), edit its own name and phone (`PATCH /profile/me`), and see its own trainer contexts and none of the parent's. It is refused `PATCH /profile/me/trainer`.

Routes carrying `NotAChildGuard`: all eight family-management endpoints, `POST /join/:code`, and `PATCH /profile/me/player`.

## Age computation

`AuthService.assertOldEnoughForOwnAccount(birthDate)` is the single gate. Every path onto an own-name account calls it: `POST /auth/register`, `POST /join/:code/register`, and `PATCH /profile/me/player`.

- Parses with `parseCalendarDate`, which rejects anything that is not exactly `YYYY-MM-DD`. An ISO date-time used to pass validation, produce an `Invalid Date`, and compare `false` against every bound — so the gate let everything through. That is why the parse is strict and shared.
- A **future** date is `422 VALIDATION_ERROR`, not `403`. A `403` would imply the date was understood and refused; it was not understood.
- Age turns over on the birthday itself: someone is admitted on the morning of their eighteenth birthday and refused the day before.
- A 29 February birthday turns 18 on 1 March in a non-leap year, because 29 February has not passed on 28 February.

## Display names

`displayNameFor(input, fallback)` (`src/shared/format/display-name.ts`) is shared by registration, the ShareLink join, and impersonation banners, so the fallback behaves identically in all three: full name if either part is set, otherwise the fallback — normally the email.

It does not normalise input; that is the DTO's job. A display name of `' '` passes a `NOT NULL` column and renders as nothing.

## Testing

| Suite | Cases | Covers |
| --- | --- | --- |
| `test/self-profile-birthdate.e2e-spec.ts` | 25 | Persistence, read-back, ShareLink parity, roster propagation, PATCH correction, the floor on PATCH, malformed dates, rollback |
| `test/child-profile-boundaries.e2e-spec.ts` | 9 | What a child may and may not do on these routes |
| `test/patch-null-handling.e2e-spec.ts` | 18 | Three-state semantics across all four PATCH endpoints |
| `src/modules/auth/auth.age-gate.spec.ts` | 17 | Boundary days, leap years, configured thresholds, malformed input |
| `src/modules/players/players.service.spec.ts` | 16 | `updateSelfProfile` scoping and partial-update rules |
| `src/shared/validation/presence.spec.ts` | 8 | `IsOptionalNotNull` |
| `src/shared/format/display-name.spec.ts` | 7 | Fallback behaviour |

The e2e suite requires `--runInBand`: each suite starts its own Postgres Testcontainer, and running them in parallel starves Docker.

## References

- [ADR-002: Birth date on the player profile](../adrs/ADR-002-birth-date-on-player-profile.md)
- [ADR-003: Password hashing outside transactions](../adrs/ADR-003-password-hashing-outside-transactions.md)
- [AuthService](../../src/modules/auth/auth.service.ts)
- [ProfileService](../../src/modules/profile/profile.service.ts)
- [ProfileController](../../src/modules/profile/profile.controller.ts)
- [IsOptionalNotNull](../../src/shared/validation/presence.ts)
- [env.validation.ts](../../src/shared/config/env.validation.ts)
