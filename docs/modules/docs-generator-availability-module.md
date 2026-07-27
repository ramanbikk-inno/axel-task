# Availability Module (US-01.09)

## Overview

The Availability module provides endpoints for managing player weekly recurring availability windows ("Best Times"). Player parents can set/view their profile's availability, and trainers can view aggregated availability across their associated players with optional filtering.

**Authorization:** All endpoints require JWT bearer token and role-based access control (PlayerParent or Trainer).

---

## Endpoints

### Player Endpoints (PlayerParent Role)

Base path: `/api/v1/players`

A child login carries the same `PlayerParent` role and may use both endpoints below for its own profile — see `requireAccessibleProfile` under Implementation Details.

#### GET `/players/:profileId/availability`

Retrieve availability windows for a specific player profile.

**Role:** `PlayerParent` (owner only)

**Parameters:**
- `profileId` (path, UUID) — Player profile ID to retrieve

**Authentication:** Bearer token required; must own the profile

**Response: 200 OK**
```json
[
  {
    "dayOfWeek": 1,
    "startTime": "17:00",
    "endTime": "20:00"
  },
  {
    "dayOfWeek": 3,
    "startTime": "18:00",
    "endTime": "19:30"
  }
]
```

**Response Schema:**
```typescript
AvailabilitySlotView[] {
  dayOfWeek: number;     // 0=Sunday, 1=Monday, ..., 6=Saturday
  startTime: string;     // 24-hour HH:MM format (00:00–23:59)
  endTime: string;       // 24-hour HH:MM format (00:00–23:59)
}
```

**Error Responses:**

| Status | ErrorCode | Message | Cause |
|--------|-----------|---------|-------|
| 403 | `PROFILE_NOT_OWNED` | You do not own this player profile. | Caller neither owns the profile nor is the child login it belongs to |
| 404 | `NOT_FOUND` | Player profile not found. | Profile ID doesn't exist |
| 401 | (JWT error) | Unauthorized | No valid bearer token provided |

---

#### PUT `/players/:profileId/availability`

Replace a player profile's full availability set (delete all, then insert new windows).

**Role:** `PlayerParent` (owner only)

**Parameters:**
- `profileId` (path, UUID) — Player profile ID to update

**Request Body:**
```json
{
  "slots": [
    {
      "dayOfWeek": 1,
      "startTime": "17:00",
      "endTime": "20:00"
    },
    {
      "dayOfWeek": 3,
      "startTime": "18:00",
      "endTime": "19:30"
    }
  ]
}
```

**Request Schema:**
```typescript
SetAvailabilityDto {
  slots: AvailabilitySlotInput[];
}

AvailabilitySlotInput {
  dayOfWeek: number;     // 0–6 (0=Sunday, 6=Saturday)
  startTime: string;     // HH:MM (00:00–23:59)
  endTime: string;       // HH:MM (00:00–23:59), must be > startTime
}
```

**Validation Rules:**
- `slots` array max size: **100**
- `dayOfWeek`: Integer, must be **0–6**
- `startTime` / `endTime`: **24-hour HH:MM format** (00:00–23:59), matches regex `^([01]\d|2[0-3]):[0-5]\d$`
- Windows are **single-day, non-midnight-crossing**: `endTime > startTime` on the same day
- Windows on the same day **must not overlap** (but touching is allowed: 17:00–18:00 and 18:00–19:00 are OK because ranges are end-exclusive)

**Response: 200 OK**
Returns the full updated availability set (same as GET response).

```json
[
  {
    "dayOfWeek": 1,
    "startTime": "17:00",
    "endTime": "20:00"
  },
  {
    "dayOfWeek": 3,
    "startTime": "18:00",
    "endTime": "19:30"
  }
]
```

**Error Responses:**

| Status | ErrorCode | Message | Cause |
|--------|-----------|---------|-------|
| 400 | `VALIDATION_ERROR` | endTime must be after startTime (day N). | `endTime ≤ startTime` |
| 400 | `VALIDATION_ERROR` | Availability windows overlap on day N. | Multiple windows on same day with overlap |
| 400 | (schema validation) | (field-specific error) | Invalid format, out-of-range value, or constraint violation |
| 403 | `PROFILE_NOT_OWNED` | You do not own this player profile. | Caller neither owns the profile nor is the child login it belongs to |
| 404 | `NOT_FOUND` | Player profile not found. | Profile ID doesn't exist |
| 401 | (JWT error) | Unauthorized | No valid bearer token |

---

### Trainer Endpoints (Trainer Role)

Base path: `/api/v1/trainers`

#### GET `/trainers/me/players/availability`

View availability for all active associated players, with optional filtering by day of week or time.

**Role:** `Trainer`

**Query Parameters (all optional):**
- `dayOfWeek` (query, integer, 0–6) — Filter to players available on this day
- `time` (query, string, HH:MM) — Filter to players available at this time (start-inclusive, end-exclusive)

**Examples:**
- `GET /trainers/me/players/availability` — All players' full weekly availability
- `GET /trainers/me/players/availability?dayOfWeek=1` — Only players available on Monday, showing each player's full weekly availability
- `GET /trainers/me/players/availability?time=18:00` — Players available at 18:00 on any day, showing each player's full weekly availability
- `GET /trainers/me/players/availability?dayOfWeek=3&time=19:00` — Players available on Wednesday at 19:00, showing each player's full weekly availability

**Authentication:** Bearer token required; trainer profile must exist

**Response: 200 OK**
```json
[
  {
    "playerProfileId": "550e8400-e29b-41d4-a716-446655440000",
    "displayName": "Alice Johnson",
    "slots": [
      {
        "dayOfWeek": 1,
        "startTime": "17:00",
        "endTime": "20:00"
      },
      {
        "dayOfWeek": 3,
        "startTime": "18:00",
        "endTime": "19:30"
      }
    ]
  },
  {
    "playerProfileId": "550e8400-e29b-41d4-a716-446655440001",
    "displayName": "Bob Smith",
    "slots": [
      {
        "dayOfWeek": 2,
        "startTime": "16:00",
        "endTime": "18:00"
      }
    ]
  }
]
```

**Response Schema:**
```typescript
PlayerAvailabilityView[] {
  playerProfileId: string;   // UUID
  displayName: string;       // Player's display name
  slots: AvailabilitySlotView[];  // Full weekly availability
}

AvailabilitySlotView {
  dayOfWeek: number;     // 0=Sunday, 1=Monday, ..., 6=Saturday
  startTime: string;     // HH:MM
  endTime: string;       // HH:MM
}
```

**Filter Semantics:**
- `dayOfWeek` filter narrows *which players* are returned (only those with a slot on that day)
- `time` filter narrows *which players* are returned (only those with a slot matching the time); matching is **start-inclusive, end-exclusive** (`startMinute ≤ queryTime < endMinute`)
- Each returned player still carries their **full weekly availability** (all 7 days) for scheduling context
- Players are returned in **deterministic order**: sorted by `displayName` (case-insensitive), then by profile `id` (UUID)

**Error Responses:**

| Status | ErrorCode | Message | Cause |
|--------|-----------|---------|-------|
| 403 | `TRAINER_PROFILE_NOT_FOUND` | No trainer profile for this account. | Authenticated user does not have a trainer profile |
| 400 | (schema validation) | (field-specific error) | Invalid `dayOfWeek` (not 0–6) or invalid `time` format |
| 401 | (JWT error) | Unauthorized | No valid bearer token |

**Empty Response:**
- Returns `200 OK []` if the trainer has no active associations or no players match the filter

---

## Data Model

### AvailabilitySlot (Persistence)

| Field | Type | Constraints | Notes |
|-------|------|-------------|-------|
| `id` | UUID | Primary key, auto-generated | |
| `playerProfileId` | UUID | Foreign key (PlayerProfile.id) ON DELETE CASCADE | Indexed |
| `dayOfWeek` | smallint | CHECK `0 ≤ dayOfWeek ≤ 6` | 0=Sunday, 6=Saturday |
| `startMinute` | integer | CHECK `0 ≤ startMinute < endMinute ≤ 1439` | Minutes from midnight |
| `endMinute` | integer | CHECK `0 ≤ startMinute < endMinute ≤ 1439` | Minutes from midnight |
| `createdAt` | timestamptz | Auto-set to now() | Read-only |

**Key Constraint:**
- Same-day overlap validation happens in the service layer (see AvailabilityService.assertValidSlots)
- Database CHECK constraints ensure numeric bounds and that start < end

### Time Storage
- User-facing API: **HH:MM strings** (24-hour format)
- Storage: **minutes-from-midnight** (integer 0–1439)
- Conversion:
  - `"17:00"` → 17 × 60 + 0 = 1020 minutes
  - `"23:59"` → 23 × 60 + 59 = 1439 minutes
  - `"00:00"` → 0 minutes

---

## Business Rules & Validation

### Input Validation (Class-Validator)

1. **dayOfWeek**: Integer, 0–6
2. **startTime**: String, matches `^([01]\d|2[0-3]):[0-5]\d$` (HH:MM, 24-hour)
3. **endTime**: String, matches `^([01]\d|2[0-3]):[0-5]\d$` (HH:MM, 24-hour)
4. **slots**: Array, max 100 items, each item validated as AvailabilitySlotInput

### Service Validation (AvailabilityService)

1. **Single-day, non-midnight-crossing**: `endTime > startTime`
   - Raises `BadRequestException { errorCode: VALIDATION_ERROR, message: "endTime must be after startTime (day N)." }`

2. **No same-day overlap**: For each day, windows must be non-overlapping (but touching is OK)
   - Validation: For sorted windows on a day, each `window[i].startTime >= window[i-1].endTime`
   - Raises `BadRequestException { errorCode: VALIDATION_ERROR, message: "Availability windows overlap on day N." }`

3. **Access check** (for PUT/GET): the caller must reach the profile — an account holder through `ownerUserId`, a child login through `principal.childPlayerProfileId`, which is their own profile and no sibling's
   - Raises `ForbiddenException { errorCode: PROFILE_NOT_OWNED }`

4. **Profile existence** (for PUT/GET): Profile must exist
   - Raises `NotFoundException { errorCode: NOT_FOUND }`

5. **Trainer profile existence** (for trainer view): Authenticated user must be a trainer
   - Raises `ForbiddenException { errorCode: TRAINER_PROFILE_NOT_FOUND }`

### Database Constraints

Table: `availability_slots`

```sql
CONSTRAINT "CHK_availability_slots_day" 
  CHECK ("day_of_week" >= 0 AND "day_of_week" <= 6)

CONSTRAINT "CHK_availability_slots_range" 
  CHECK ("start_minute" >= 0 AND "end_minute" <= 1439 AND "start_minute" < "end_minute")

CONSTRAINT "FK_availability_slots_player" 
  FOREIGN KEY ("player_profile_id") REFERENCES "player_profiles"("id") ON DELETE CASCADE
```

---

## Usage Examples

### Set a Player's Availability (As Parent)

```bash
curl -X PUT http://localhost:3000/api/v1/players/550e8400-e29b-41d4-a716-446655440000/availability \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "slots": [
      { "dayOfWeek": 1, "startTime": "17:00", "endTime": "20:00" },
      { "dayOfWeek": 3, "startTime": "18:00", "endTime": "19:30" },
      { "dayOfWeek": 5, "startTime": "16:00", "endTime": "19:00" }
    ]
  }'
```

**Response:**
```json
[
  { "dayOfWeek": 1, "startTime": "17:00", "endTime": "20:00" },
  { "dayOfWeek": 3, "startTime": "18:00", "endTime": "19:30" },
  { "dayOfWeek": 5, "startTime": "16:00", "endTime": "19:00" }
]
```

### View a Player's Availability (As Owner Parent)

```bash
curl -X GET http://localhost:3000/api/v1/players/550e8400-e29b-41d4-a716-446655440000/availability \
  -H "Authorization: Bearer <token>"
```

### View Players' Availability (As Trainer)

**All players' full availability:**
```bash
curl -X GET http://localhost:3000/api/v1/trainers/me/players/availability \
  -H "Authorization: Bearer <trainer-token>"
```

**Filter: available on Wednesday (day 3):**
```bash
curl -X GET "http://localhost:3000/api/v1/trainers/me/players/availability?dayOfWeek=3" \
  -H "Authorization: Bearer <trainer-token>"
```

**Filter: available at 18:00 on any day:**
```bash
curl -X GET "http://localhost:3000/api/v1/trainers/me/players/availability?time=18:00" \
  -H "Authorization: Bearer <trainer-token>"
```

**Filter: available on Wednesday at 18:00:**
```bash
curl -X GET "http://localhost:3000/api/v1/trainers/me/players/availability?dayOfWeek=3&time=18:00" \
  -H "Authorization: Bearer <trainer-token>"
```

---

## Implementation Details

### Service Layer (AvailabilityService)

**Key Methods:**

- `setForProfile(principal, profileId, slots)` — Validates access, validates slots, deletes old slots, inserts new ones (transaction).
- `getForProfile(principal, profileId)` — Validates access, returns current slots.
- `requireAccessibleProfile(principal, profileId)` — The access rule for both. A parent reaches every profile they own; a child reaches exactly the one `principal.childPlayerProfileId` names. Takes the whole principal rather than a user id because a child's profile is owned by their *parent*, so an `ownerUserId` comparison alone locked a child out of their own Best Times.
- `trainerView(trainerUserId, query)` — Validates trainer profile, fetches associated players, applies day/time filter, returns sorted by displayName then id.
- `assertValidSlots(input)` — Validates no same-day overlap, no midnight-crossing.

### Database

**Table:** `availability_slots` (created by migration `1700000800000-CreateAvailability`)

**Indexes:**
- Primary key on `id`
- Index on `player_profile_id` for fast profile lookups

**Cascade:** `ON DELETE CASCADE` from `player_profiles`, so deleting a player profile removes all their availability slots.

---

## Testing

### Unit Tests
- Validation rules (endTime > startTime, no overlap, dayOfWeek range)
- Ownership checks
- Trainer view filtering (by day, by time)
- Error code propagation

### Integration Tests
- End-to-end PUT/GET flow
- Replace semantics (old slots deleted, new slots inserted)
- Trainer filter returning correct subset
- Database constraints enforced

### Example Test Cases

```typescript
describe('Availability Module', () => {
  describe('setForProfile', () => {
    it('should replace full availability set', async () => {
      // Set initial slots
      // Set new slots
      // Assert old slots gone, new slots present
    });

    it('should reject overlapping windows on same day', async () => {
      // Attempt to set overlapping 17:00–18:30 and 18:00–19:00
      // Expect VALIDATION_ERROR
    });

    it('should allow touching windows (end-exclusive)', async () => {
      // Set 17:00–18:00 and 18:00–19:00
      // Expect success
    });

    it('should reject if user does not own profile', async () => {
      // Attempt as different user
      // Expect PROFILE_NOT_OWNED (403)
    });
  });

  describe('trainerView', () => {
    it('should filter by dayOfWeek', async () => {
      // Create players with slots on different days
      // Filter by dayOfWeek=1
      // Assert only players with Monday slots returned
    });

    it('should filter by time (start-inclusive, end-exclusive)', async () => {
      // Create player with 17:00–18:00 slot
      // Filter by time=17:00 → included
      // Filter by time=18:00 → not included
      // Filter by time=16:59 → not included
    });

    it('should return full weekly availability even with day/time filter', async () => {
      // Create player with slots on multiple days
      // Filter by dayOfWeek=1
      // Assert all days still in response
    });

    it('should reject if user is not a trainer', async () => {
      // Attempt as PlayerParent
      // Expect TRAINER_PROFILE_NOT_FOUND (403)
    });
  });
});
```

---

## Migration & Deployment

**Migration:** `1700000800000-CreateAvailability`

**Steps:**
1. Create `availability_slots` table with columns, constraints, foreign key, and index
2. No data migration needed (greenfield feature)

**Rollback:**
1. Drop `availability_slots` table

**Notes:**
- No existing data to migrate
- Safe to deploy independently (no schema conflicts with other modules)

---

## References

- **Codebase:**
  - [Availability Controller](../../src/modules/availability/availability.controller.ts)
  - [Availability Service](../../src/modules/availability/availability.service.ts)
  - [Availability DTO](../../src/modules/availability/dto/availability.dto.ts)
  - [Availability Slot Entity](../../src/modules/availability/entities/availability-slot.entity.ts)
  - [Migration](../../src/shared/database/migrations/1700000800000-CreateAvailability.ts)

- **Architecture:**
  - [ADR-001: Availability Window Data Model](../adrs/ADR-001-availability-model.md)
  - [Error Codes](../../src/shared/errors/error-codes.ts)

- **Related Modules:**
  - Enrollment / Trainer-Player Associations
  - Players (Player Profiles)
  - Users (Authentication, Roles)
