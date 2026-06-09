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
