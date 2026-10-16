# Changelog

## Unreleased

### Added
- **OpenAPI spec and Swagger UI**: `@fastify/swagger` generates the spec from Zod schemas. Served at `/docs` (Swagger UI) and `/openapi.json` (raw spec). Amount fields documented as decimal strings.
- **Cursor pagination**: All list endpoints accept `cursor` and `limit`. Responses carry `nextCursor` (null when exhausted). Cursors encode `(createdAt, id)` as base64url. Offset pagination kept with a `Deprecation` header for one release.
- **RPC retention gap detection**: The indexer detects when its cursor falls outside the RPC retention window, marks itself degraded (`gap` flag in `IndexerState`), and `/ready` returns 503 with gap details and a pointer to `docs/RUNBOOK.md`.
- **Backfill command**: `npm run indexer:backfill -- --from <ledger> [--to <ledger>]` replays events without touching the cursor. Idempotent; refuses to start before the RPC retention window.
- **`docs/RUNBOOK.md`**: Recovery procedures for the retention gap.
- **`/v1` API versioning**: every route is also served under `/v1`. The unversioned paths remain as aliases and carry `Deprecation: true` plus a `Link` header naming the `/v1` successor.
- **`X-Request-Id`**: accepted (validated, log-safe) or generated, echoed on every response and present as `reqId` in the matching log line.
- **GET /vouchers.csv**: streamed RFC 4180 CSV export with the same filters as `GET /vouchers`. At least one filter is required and there is no beneficiary reference column.
- **GET /services**: Service catalogue across active clinics, grouped by code, with unique labels, clinic count and min/max/median price. Aggregates are computed with `BigInt`; the median of an even number of prices is the floor of the mean of the two middle values.
- **GET /services/:code**: Active clinics offering one service code, cheapest first, each with `price` and `priceDisplay`.
- **GET /countries**: Countries with at least one active clinic and their clinic counts, for building filters without paging every provider.
- **GET /providers?q=**: Case-insensitive clinic name search, length-capped at 64 characters. Uses `mode: 'insensitive'` on Postgres; SQLite's `LIKE` is case-insensitive for ASCII.
- **GET /vouchers sort options**: `?sort=createdAt|expiresAt|amount` and `?order=asc|desc` (defaults `createdAt`/`desc`, matching previous behaviour). `amount` is sorted numerically with `BigInt`, not lexicographically; ties fall back to the voucher id in the same direction.
- **GET /receipts?provider=**: List receipts by clinic/provider. Beneficiary references omitted in this view.
- **GET /receipts/:voucherId**: Fetch a single receipt by voucher ID for shareable receipt pages and verification. No beneficiary reference in response.
- **GET /vouchers/due?within=72h**: Vouchers needing action soon (expiring, becoming refundable, or settleable) with funder or provider filter. Uses lifecycle logic from `src/lib/lifecycle.ts` so API and contracts agree.
- **Multi-status filter for vouchers**: `?status=Claimed,Attested` accepts comma-separated list validated against the status enum; invalid values rejected.
- **`READY_MAX_LAG_LEDGERS`** (default `120`): lag in ledgers at which `/ready` reports degraded. The response echoes it as `checks.maxLagLedgers`.
- **Split API and indexer entry points**: `npm run start:api` and `npm run start:indexer`; combined `npm start` stays the default. Commented two-service example in `render.yaml`.
- **Indexer lease**: `IndexerState.leaseOwner` / `leaseExpiresAt` make the cursor single-writer. Standby instances log and retry instead of racing the cursor.

### Changed
- **List endpoints**: Prefer `cursor`/`limit` over `offset`/`limit`. Offset pagination still works but returns a `Deprecation` header.
- **`IndexerState` schema**: three nullable columns added (`gap`, `gapOldestLedger`, `gapCursorLedger`); `prisma db push` adds them in place.
- **Error responses**: every route now returns the one `{ error, message, details? }` envelope via the app-level error and not-found handlers. Unhandled failures are `internal_error`, with the cause left in the log rather than the response.
- **GET /receipts**: Now requires exactly one of `beneficiaryRef` or `provider` query parameters.
- **GET /vouchers**: Status filter now accepts comma-separated values (e.g., `Claimed,Attested`) instead of a single value.
- **Indexer logs**: skipped events now include the transaction hash and ledger; an unknown event name is warned once per process instead of silently ignored.
- **`IndexerState` schema**: two nullable columns added; `prisma db push` adds them in place (no backfill needed).

## 0.2.0 — 2026-10-09

### Fixed
- **indexer:** follows the RPC cursor across pages. Previously any backlog over 200 events lost everything after the first page, because the cursor jumped to the RPC tip.

### Added
- Route tests for every endpoint against a throwaway SQLite database, through a new `buildApp()` that builds the API without starting the indexer. Tests: 57 (was 19).
- Issue forms (bug, feature) and a pull request template; blank issues off, security reports routed to SECURITY.md.
- `serviceLabel` on vouchers and receipts; `refundableAt` and `disputeReason` on vouchers. `isRefundable` follows the contract's claim-grace rule.
- `Voucher.disputeReason` column (nullable; `prisma db push` adds it in place).
- `npm run lint` (ESLint 9 + typescript-eslint) and a lint job in CI.

### Changed
- Points at the 2026-10-07 testnet deployment; `INDEXER_START_LEDGER` updated.

## 0.1.0 — 2026-09-02

Initial indexer and read API.
