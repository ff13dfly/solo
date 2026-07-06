# Core Shared Libraries (`api/library`)

This directory contains the "Soul and Contracts" of the system. These libraries are shared across microservices to ensure architectural consistency, protocol compliance, and developer efficiency.

## The Architectural Trade-off: Coupling vs. Stability

Using a shared library in a microservices environment involves a deliberate strategic choice.

### 1. The Benefit: High Stability & Consistency
- **Unified Language**: By using shared `constants.js`, we ensure that the Router, Portal, and all Microservices speak the same lifecycle language (e.g., `ACTIVE`, `DELETED`).
- **Reduced Human Error**: IDE autocompletion for constants and factory methods prevents "silent failures" caused by typos in hardcoded strings.
- **Global Agility**: If a system-wide protocol change is required (e.g., changing status strings to integers), it can be implemented in one place rather than across dozens of repositories.
- **Developer Velocity**: Common patterns (CRUD, ID generation, Logging) are provided out-of-the-box, allowing engineers to focus on business domain logic.

### 2. The Cost: Explicit Coupling
- **Dependency Chains**: Microservices become dependent on the presence of the `library` directory.
- **Monorepo Gravity**: This approach is optimized for a Monorepo. Decoupling a single service for independent deployment outside this repo requires more effort (copying the lib or packaging it as an NPM module).

## Library Catalog

| Module | Responsibility | Why it's shared |
| :--- | :--- | :--- |
| `auth.js` | Service-side auth middleware | Parses the signed `X-Router-Token` into `req.user` / `req.permit` / `req.constraints` (see CLAUDE.md §7). |
| `bootstrap.js` | Service boot helpers | Redis connect + seeds default categories **and indexes them into `{SERVICE}:CONFIG:CATEGORY_IDX`** so `category.list` can find them. |
| `category.js` | Federated Categories | Coordinates shared namespaces via the Router (reserve) + local CRUD. |
| `clock.js` | Injectable Time Source | Drop-in replacement for `Date.now()`. Production behaves identically; tests with `CLOCK_TEST_MODE=true` can `freeze`/`fastForward`/`reset` time without touching system clock. Time-manipulation methods throw outside test mode (payment-system safety). |
| `config.js` | Shared config resolution | Central place for env-driven config (ports, redis URL) so services don't each reinvent it. |
| `constants.js` | System states & enums | Prevents semantic drift between Router, UI, and Logic. |
| `crypto.js` | Hashing & signing primitives | One implementation of SHA-256 / Ed25519 helpers — no per-service crypto. |
| `entity.js` | CRUD & Indexing Factory | Standardizes Redis key naming, anti-collision IDs, MULTI/EXEC, and WAL. |
| `fieldmask.js` | Field-level visibility | Masks `sensitiveFields` consistently (orthogonal to row-level `constraints`). |
| `filestore.js` | Content-addressed (CAS) storage | SHA-256 addressed blobs — same content → same path, de-duplicated. |
| `generator.js` | ID Generation | Guarantees entropy-safe Base58 identifiers. |
| `indexer.js` | RediSearch index management | FT.*/JSON index lifecycle — single source of truth for index schemas. |
| `jsonlogic.js` | JsonLogic evaluation | Shared rule engine for declarative conditions (e.g. fulfillment transitions). |
| `jsonrpc.js` | Protocol & Error Catalog | Ensures every service responds with valid JSON-RPC 2.0. |
| `logger.js` | Audit Trace Storage | Implements the standardized 3-level directory log partitioning + WAL. |
| `optimistic.js` | Optimistic locking | Read-modify-write with version checks; auto-falls back to plain RMW when `duplicate()` is unavailable. |
| `passport.js` | External-identity anchors | Account-less, anchor-bound device tokens for external users (see authority.md). |
| `permit.js` | Permit helpers | `isAdmin` (`req.permit === 'admin'`), footprint precheck — the compressed-permit contract (§7). |
| `ports.js` | Service port resolution | `portFor()` with env override — keeps ports consistent with `services.json`. |
| `process.js` | Process / worker helpers | Shared worker lifecycle / message correlation utilities. |
| `relay.js` | Bot-token lifecycle | The ONLY place that mints/rotates relay bot tokens (security.md §7.7) — services must not reimplement. |
| `router-auth.js` | `parseRouterToken` | Decodes + Ed25519-verifies the Router token; the canonical §7 parser new services should reuse. |
| `search.js` | In-Memory Search & RediSearch Utils | `applySearch` pipeline (match→keyword→filter→sort→paginate) for small datasets; `escapeTag` for RediSearch TAG queries. Single source of truth — do not reimplement in microservices. |
| `validate.js` | Param-string hygiene | `PATTERNS` registry + `checkString`/`hasControlChars`/`isBlank`/`normalizeString`. Backs the Router's param validator and per-service semantic checks (declare in the schema, enforce at the Router, implement here). |
| `vector.js` | Vector search helpers | ⚠️ **未实现桩**（占位、零生产引用；见 `docs/planning/BACKLOG.md` §6）。设想：Embedding/KNN utilities over redis-stack。 |

## Test Coverage

Hermetic unit tests live in `tests/` (pure assertions, or a Map-backed **fake** redis — no real services, no network). They run in the CI green subset (`jest.ci.config.js`). When changing a covered module, keep its test green; when adding a module, add a test.

- **Covered (hermetic):** `auth`, `bootstrap`, `clock`, `constants`, `crypto`, `fieldmask`, `filestore`, `generator`, `jsonlogic`, `jsonrpc`, `optimistic`, `passport`, `permit`, `ports`, `router-auth`, `validate` (+ `wal-recovery`, a cross-cutting WAL test).
- **Integration-only (not yet unit-tested):** `category`, `config`, `entity`, `indexer`, `logger`, `process`, `relay`, `search`, `vector` — these need a real redis-stack (FT/JSON), make Router RPCs, or have disk side-effects, so a hermetic test would be brittle. They're exercised indirectly via the repo-root `e2e/` service suites; a dedicated redis-stack integration tier is a future addition.

## Guiding Principles

1. **Protocol over Implementation**: We prefer sharing **Protocols** (how data looks) via **Logic Factories** (how we write data).
2. **显式优于隐式 (Explicit > Implicit)**: We prefer explicit code dependencies (`require(lib/constants)`) over implicit runtime dependencies (hoping everyone writes the same string).
3. **Core is Sacred**: Changes to `api/library` affect the entire ecosystem. Any modification must maintain backward compatibility or trigger a system-wide audit.
