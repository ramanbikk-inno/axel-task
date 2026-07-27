# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-07-27

### Added

- Expire idle sessions at refresh via configurable `SESSION_IDLE_TIMEOUT` (default 24h) (cc4eb4c)
- Let a parent set a child profile's photo (cc4eb4c)
- Let Super Admin edit trainer/coach/player role-specific profile fields (cc4eb4c)

### Fixed

- Keep the birth date registration collects; add a minimum self-registration age gate and close four defects it exposed (733a418)

## [0.1.0] - 2026-07-26

First tagged release. Covers Epic-01 (User Management & Authentication).

### Added

- Close the remaining MVP API gaps and reject explicit null on every PATCH (d28900f)
- Let a parent choose who joins, and give the trainer a roster (b6c2c18)
- Give erasure a legal record, and finish the PII sweep (7e94d26)
- Stop orphaning replaced images, and let a coach edit their profile (7e58d25)
- Give the coach engagement a lifecycle (9918331)
- Attribute impersonated actions to the admin, and report them (90b6ca5)
- Child logins with the constraints US-01.06 actually requires (69b12ba)
- Make the active trainer context a real, persisted selection (ae6cdb7)
- Add the Epic-01 columns the data model was missing (1afd5ff)
- Coach My Times, conflict check and override log (US-01.10) (92fb50a)
- Add player Best Times + trainer availability view (US-01.09) (824122f)
- Add trainer coach invites via unique ShareLink (US-01.08) (34a3a67)
- Add portal branding — logo upload + primary color (US-01.14) (dd02809)
- Add GDPR delete/anonymize user with compliance log (US-01.13) (c29154b)
- Add self-service profile editing + Super Admin edit user (US-01.11) (34977a0)
- Manage child-trainer associations + context selector (US-01.04) (18d8637)
- Add child profiles + trainer selection (US-01.03) (db34d75)
- Add ShareLink join + player profiles + multi-trainer (US-01.02) (ee06f37)
- Add user deactivate/reactivate with session revocation (US-01.12) (23ef1d0)
- Add impersonate/exit flow with 1h cap + audit log (US-01.07) (1894e23)
- Trainer-creation audit log + Super Admin users directory (US-01.01) (23c6b5f)
- Add create-trainer + setup-password flow (US-01.01) (d537cbb)
- Add CASL AbilityFactory, PoliciesGuard, @CheckPolicies and AbilityModule (5264780)
- Add @Roles decorator and RolesGuard reading request.user.role (8b61679)
- Add throttler with AuthThrottlerGuard keyed on IP+identifier (9d4d453)
- Add password reset (1h) + authenticated change-password (5dbf8f1)
- Wire email verification (24h) + verify-email/resend endpoints (63a9600)
- Add idempotent logout revoking session + refresh token (c737455)
- Add refresh token rotation with family reuse detection (a3018c3)
- Add login, enumeration-safe register, /auth/me + AuthService with issueTokensForSession (686bc6f)
- Add stateless JwtStrategy + JwtAuthGuard mapping claims to Principal (c0ad39b)
- Add auth session/token entities and CreateAuthEntities migration (4bd9704)
- Add Principal, auth token types, and TokenService (JWT access/refresh + opaque tokens) (db2d2e3)
- Add mail and storage modules plus full UsersService surface; wire into AppModule (T11) (20f0e61)
- Idempotent SuperAdmin seed; make Resend/Cloudinary env optional (T10) (464148e)
- Add argon2id PasswordService and CryptoModule (T9) (e6e499e)
- Add User entity, Role/UserStatus enums, and CreateUsers migration (T8) (33a95f0)
- Add ErrorCode enum, global exception filter, clock and health modules (T6) (1136674)
- Add TypeORM AppDataSource and DatabaseModule with glob auto-discovery (T4) (10aff09)
- Add zod env validation with fail-fast config and ARGON defaults (T3) (78001c5)

### Fixed

- Resolve a coach re-hire mix-up, three PII leaks, and the audit blind spots (4463fec)
- Stop login leaking the password policy and close the impersonation password escape (45bae5b)
- Close the child age bypass and the validation gaps around it (61181b9)
- Stop the unconfigured-storage test depending on the CI environment (3ccba1d)
- Close code-review findings on coach My Times (bcc6afe)
- Make org scoping real and define Coach/PlayerParent abilities (5d02b10)
- Implement real uploads and verify image content (891511a)
- Close rate-limit bypasses, enable CORS, revoke sessions on password change (afd2a95)
- Enforce ShareLink type on redemption and lock single-use links (bd1c564)
- Stop deactivated and deleted accounts from resurrecting themselves (ec9928e)
- Revalidate access tokens against session and user state (95d3605)
- Harden Best Times validation + add test coverage (US-01.09) (af0dc15)
- Lazily init Resend client so the app boots without RESEND_API_KEY (ef7804e)
