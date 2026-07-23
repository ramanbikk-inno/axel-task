# ADR-001: Availability Window Data Model (Single-Day, End-Exclusive, Replace-Not-Append)

**Date:** 2026-07-23  
**Status:** Accepted  
**Feature:** US-01.09 (Availability / "Best Times")

## Context

Player profiles need to express weekly recurring availability ("Best Times") for trainers to view when players are available for scheduling. The availability system must support:
- Weekly recurrence (each day of the week 0–6)
- Multiple windows per day (e.g., morning and evening slots)
- Filtering by trainers (by day, by time)
- Atomic updates (parent replaces full set, no partial append)

Key constraints from the domain:
1. Scheduling happens during business hours (00:00–23:59), never across midnight.
2. The system must allow "touching" windows (17:00–18:00 and 18:00–19:00 on the same day) because they don't overlap.
3. Parents should be able to reset availability in one operation without transactional conflicts.

## Decision

We implement a **single-day, end-exclusive, replace-not-append** model:

1. **Single-Day Windows**: Each availability slot is confined to one calendar day; windows never cross midnight.
   - `dayOfWeek` ∈ [0, 6] where 0 = Sunday, 6 = Saturday
   - `startMinute` and `endMinute` are minutes from midnight: [0, 1439]
   - Constraint: `0 ≤ startMinute < endMinute ≤ 1439`

2. **End-Exclusive Ranges**: Time ranges are end-exclusive (half-open intervals).
   - 17:00–18:00 (`startMinute=1020`, `endMinute=1080`) covers 17:00:00–17:59:59
   - 18:00–19:00 (`startMinute=1080`, `endMinute=1140`) covers 18:00:00–18:59:59
   - These **do not overlap** and can coexist on the same day
   - Trainer filter match: `time` is start-inclusive, end-exclusive: `startMinute ≤ queryTime < endMinute`

3. **Replace-Not-Append**: The `PUT /players/:profileId/availability` endpoint **replaces** the entire weekly availability set.
   - Request body: `{ slots: AvailabilitySlotInput[] }`
   - Old slots for the profile are deleted; new slots are inserted in a single transaction
   - This eliminates the need for merge logic and prevents orphaned windows

4. **Validation at Service Layer**: Business rules (no overlap on same day) are validated in the service; database CHECK constraints enforce numeric bounds as defense-in-depth.

## Consequences

### Positive
- **Simplicity**: Single-day windows eliminate midnight-boundary logic and time-zone confusion.
- **Determinism**: Replace semantics make parent updates idempotent and easy to reason about.
- **Efficiency**: Trainer filtering is fast (in-memory sort/filter on small result sets).
- **Correctness**: End-exclusive ranges prevent off-by-one errors and allow adjacent windows.
- **Robustness**: Database constraints guarantee data integrity even if service code has bugs.

### Negative
- **No Partial Updates**: Parents must fetch, modify, and send back the full list. Concurrent edits are safe (last-write-wins) but may lose intermediate changes if not coordinated at the UI level.
- **No Midnight Spans**: Availability across midnight (e.g., "available 22:00–02:00") cannot be expressed without splitting into two days. This is acceptable for sports scheduling (unlikely use case).

### Neutral
- Time is stored as minutes-from-midnight (integer), not ISO strings, for efficient range queries and comparison.
- Trainer filter by `dayOfWeek` or `time` narrows *which players* are returned; each player's full weekly availability is still included in the response for scheduling context.

## References
- [Availability Controller](../../src/modules/availability/availability.controller.ts)
- [Availability Service](../../src/modules/availability/availability.service.ts)
- [Availability DTO](../../src/modules/availability/dto/availability.dto.ts)
- [CreateAvailability Migration](../../src/shared/database/migrations/1700000800000-CreateAvailability.ts)
