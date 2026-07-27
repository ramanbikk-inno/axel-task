# axel-task

Backend API for the multi-tenant sports-trainer SaaS (Epic-01: User Management & Authentication).

## Stack

- NestJS 10 (TypeScript strict) + Express
- PostgreSQL 16 + TypeORM (migrations, no `synchronize`)
- Self-hosted JWT auth (Passport + `@nestjs/jwt`), argon2id
- CASL authorization
- Resend (email) + Cloudinary (storage) behind swappable modules

## Prerequisites

- Node 20 LTS (newer also works)
- Docker (local Postgres + integration/e2e Testcontainers)

## Setup

```bash
npm install
cp .env.example .env   # then fill in secrets
docker compose up -d   # local Postgres 16
npm run migration:run
npm run seed:super-admin
npm run start:dev
```

API: http://localhost:3000/api/v1 — Swagger: http://localhost:3000/api/docs

## Scripts

- `npm run build` / `npm run start:dev`
- `npm run lint` / `npm run format`
- `npm test` (unit + integration) / `npm run test:e2e`
- `npm run migration:run` / `npm run migration:revert`
- `npm run seed:super-admin`

The e2e suite needs `--runInBand` (`npm run test:e2e -- --runInBand`). Each suite starts its own
Postgres Testcontainer, so running them in parallel starves Docker.

## Configuration

Everything is validated by a zod schema at startup ([env.validation.ts](src/shared/config/env.validation.ts)),
so a bad value fails the boot rather than surfacing later. Beyond the secrets in `.env.example`,
these change behaviour:

| Variable | Default | Effect |
| --- | --- | --- |
| `MIN_SELF_REGISTRATION_AGE` | `18` | Minimum age to hold an account in your own name. Below it, a player belongs to a parent's account as a child profile. `0` admits anyone born in the past. |
| `SESSION_IDLE_TIMEOUT` | `24h` | A session unrefreshed for longer than this is rejected at its next refresh attempt, ahead of the full `JWT_REFRESH_TTL` window. |
| `ARGON_MEMORY_KIB` / `ARGON_TIME_COST` / `ARGON_PARALLELISM` | `19456` / `2` / `1` | argon2id cost. Raising these rehashes each password on next login. |
| `TRUST_PROXY` | *(empty)* | Reverse-proxy hop count. Anything above `0` makes Express believe `X-Forwarded-For`, so set it only when a proxy really does rewrite that header. |
| `JWT_ISSUER` / `JWT_AUDIENCE` | `axel-api` / `axel-app` | Bound into every token and checked on the way back in, so a token minted by another deployment sharing a secret is rejected. |

## Docs

### Decisions

- [ADR-001](docs/adrs/ADR-001-availability-model.md) — availability windows: single-day, end-exclusive, replace-not-append
- [ADR-002](docs/adrs/ADR-002-birth-date-on-player-profile.md) — birth date lives on the player profile, not on `users`
- [ADR-003](docs/adrs/ADR-003-password-hashing-outside-transactions.md) — password hashing happens outside database transactions
- [ADR-004](docs/adrs/ADR-004-session-idle-timeout.md) — session idle timeout enforced at refresh

### Modules

- [Availability](docs/modules/docs-generator-availability-module.md)
- [Self-profile & registration age rules](docs/modules/docs-generator-self-profile-module.md)
