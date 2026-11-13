# SOLO v1.3.4 Adversarial Security Audit Report (Run-2)

- **Audit Date**: 2026-11-13
- **Standard**: Cloudflare `security-audit` Skill + SOLO `run-2` Adversarial Deep-Audit Standard (`~/.agents/rules/security-cadence.md`)
- **Scope**: All `v1.3.4` capabilities and core trust boundaries across 3 independent domains (`library/sealed-envelope.js`, `library/entity.js`, `core/user`, `apps/fulfillment`, `library/ssrf.js`, `library/outbound.js`, `library/peer-relay.js`, `library/injection-detect.js`, `core/agent/providers/*`, `deploy/seed-bots.js`, `autocheck/static/security.js`).
- **Constraint Compliance**: Zero changes to `api/router/*`. All findings verified via Red-to-Green unit tests in `api/tests/unit/security-run2-v134.test.js`.

---

## 1. Executive Summary & Audit Matrix

| ID | Severity | Domain | Component / File | Finding Summary | Status |
| :--- | :---: | :--- | :--- | :--- | :---: |
| **P0-1** | 🔴 P0 | Domain 1 | `api/library/sealed-envelope.js` | AES-256-GCM tag truncation forgery (missing `authTagLength: 16` & byte-length checks), non-recursive AAD canonicalization, and missing `keyId` fingerprint verification | **FIXED & VERIFIED** |
| **P0-2** | 🔴 P0 | Domain 1 | `api/core/user/logic/{bot,user,role,anchors}.js` | Fail-open in delegated `user.token.revoke` for `__admin__` / missing `user:<uid>` records, non-string `uid` type confusion, and cross-path protected-account check drift (`operator` & high-privilege role permits) | **FIXED & VERIFIED** |
| **P0-3** | 🔴 P0 | Domain 2 | `api/apps/fulfillment/logic/{instance,lint}.js` | Confused-deputy & bot token exfiltration in `fetchMissingSourcedMeta` (`meta_fields[].source` calling `user.token.refresh` or mutating RPCs with `system.fulfillment` authority, plus cross-tenant source object read) | **FIXED & VERIFIED** |
| **P0-4** | 🔴 P0 | Domain 2 | `api/apps/fulfillment/logic/{barrier,instance}.js` | `fulfillment.barrier.*` multi-owner (`$owner.values`) collapse to `undefined`, unscoped global `barrierKey` collision, non-admin `onSettled.target='local'` escalation, and peer credential exfiltration on custom `endpoint` override | **FIXED & VERIFIED** |
| **P0-5** | 🔴 P0 | Domain 3 | `api/core/agent/providers/index.js` & `deploy/seed-bots.js` | Production caller-supplied `model: "mock"` / `"mock/1"` bypass of `agent.decide` inverted gate, and leftover 24h `session:solo-dev-admin` token in `seed-bots.js` | **FIXED & VERIFIED** |
| **P1-1** | 🟠 P1 | Domain 1 | `api/library/entity.js` | Multi-owner (`$owner.values: ['B01','B02']`) cross-store record reassignment on `entity.update()`, missing `assertOwned` inside `optimisticUpdate`, and unguarded `entity.compact()` for `$owner` callers / `archiveDir` traversal | **FIXED & VERIFIED** |
| **P1-2** | 🟠 P1 | Domain 2 | `api/apps/fulfillment/logic/{instance,barrier}.js` | `instance.reap` ignoring `$owner.values`, `instance.create({ idempotent: true })` backfill scan poisoning across multi-owner stores, and `barrier.checkin`/`reap` CAS retry boolean state leak + orphan index cleanup | **FIXED & VERIFIED** |
| **P1-3** | 🟠 P1 | Domain 3 | `api/library/{ssrf,outbound,peer-relay}.js` & `solo-peer.js` | Non-canonical IPv6 SSRF bypasses (`0::1`, `::0:1`, expanded IPv4-mapped `0:0:0:0:0:ffff:...`, IPv4-compatible, NAT64, 6to4, Teredo, `*.nip.io`), cross-origin redirect header/body leak & HTTPS downgrade, and default `_meta.hop` propagation | **FIXED & VERIFIED** |
| **P2-1** | 🟡 P2 | Domain 3 | `api/core/agent/providers/ollama.js`, `injection-detect.js`, `autocheck/static/security.js` | Unbounded `options.num_ctx`/`num_predict` forwarding in `OllamaProvider`, inline delimiter spoofing & `depth > 16` truncation in `injection-detect.js`, and non-recursive `logic/` scan in `autocheck` | **FIXED & VERIFIED** |

---

## 2. Detailed Findings & Remediations

### 🔴 [P0-1] `api/library/sealed-envelope.js` — AES-256-GCM Tag Truncation, AAD Canonicalization & KeyId Binding
- **Root Cause**:
  1. `crypto.createDecipheriv('aes-256-gcm', dek, iv)` was called without `{ authTagLength: 16 }`, and neither `isSealedEnvelope` nor `openEnvelope` checked `tagBuf.length === 16`, `ivBuf.length === 12`, or `dek.length === 32`. Node.js OpenSSL GCM accepts 4-byte (32-bit) truncated tags unless `authTagLength: 16` is specified.
  2. `serializeAad` treated arrays as plain objects (`{"0":...}`) and only sorted top-level object keys.
  3. `openEnvelope` did not verify `envelope.keyId` against the recipient `privateKeyPem`'s SPKI SHA-256 fingerprint.
- **Fix**:
  - Enforced `GCM_IV_BYTES = 12`, `GCM_TAG_BYTES = 16`, `DEK_BYTES = 32`, and `wrappedBuf.length >= 256` across `isSealedEnvelope` and `openEnvelope`, passing `{ authTagLength: 16 }` to `crypto.createDecipheriv`.
  - Added recursive `canonicalizeAadValue` preserving array vs. object structure and sorting nested keys at all depths.
  - Verified `envelope.keyId === computeKeyFingerprint(privateKeyPem)` when `keyId` uses `sha256:<hex>`, and stripped `__proto__`/`constructor`/`prototype` in `JSON.parse`.

### 🔴 [P0-2] `api/core/user/logic/{bot,user,role,anchors}.js` — Fail-Closed Delegated `user.token.revoke` & Cross-Path Protected-Account Parity
- **Root Cause**:
  1. In `bot.js:revoke`, when `isDelegatedNonAdmin` was `true` and `uid` was `'__admin__'` (the Redis key `USER:SESSIONS:__admin__` used by `core/administrator`) or any `uid` without a `user:<uid>` record, `redisClient.get('user:__admin__')` returned `null` and failed open into `killSessions('__admin__')`.
  2. Non-string `uid` (e.g. `['system.steward']`) bypassed `typeof uid === 'string' && uid.startsWith('system.')`.
  3. `user.js:isAdminAccount` (`passwordReset`, `update`) and `role.js:assign` only checked `admin`, omitting `operator` (`role === 'operator'`, `categories.POWER === 'operator'`) and high-privilege role permits (`isHighPrivilegeRoleDoc`).
- **Fix**:
  - Added `'__admin__'` and `'operator'` to `RESERVED_ANCHORS` in `anchors.js`.
  - Unified `isProtectedUserAccount(u)` in `role.js` and shared it across `role.js`, `bot.js`, and `user.js`.
  - Hardened `bot.js:revoke` to require a non-empty string `uid` without whitespace/wildcards, block `system.*` and `isReservedAnchorSyntax(uid)`, and **fail closed** (`FORBIDDEN`) when neither `user:<uid>` nor `USER:PASSPORT:<uid>` exists.

### 🔴 [P0-3] `api/apps/fulfillment/logic/{instance,lint}.js` — Confused-Deputy & Bot Token Exfiltration in `fetchMissingSourcedMeta`
- **Root Cause**:
  - `fetchMissingSourcedMeta` invoked `relay.call(fullMethod, resolvedParams)` using `system.fulfillment`'s bot token without restricting `service` or `method` suffix. A profile declaring `source: { service: 'user', method: 'token.refresh', pick: 'token' }` passed `lintProfile` and wrote `system.fulfillment`'s live Bearer token into `instance.meta`. Furthermore, fetched records were not checked against the instance/caller `$owner` scope.
- **Fix**:
  - Added `isSafeMetaSourceMethod(fullMethod)` in `lint.js` (enforcing `READ_ONLY_SOURCE_SUFFIXES = new Set(['get', 'list', 'query', 'search', 'count', 'resolve', 'info'])` and blocking `FORBIDDEN_SOURCE_SERVICES = new Set(['user', 'admin', 'administrator', 'setting', 'system'])`).
  - Upgraded missing `source.service` / `source.method` in `lintProfile` from warning to error.
  - Enforced `isSafeMetaSourceMethod` and `matchesOwner(effectiveOwner, res)` at runtime in `instance.js:fetchMissingSourcedMeta`.

### 🔴 [P0-4] & 🟠 [P1-2] `api/apps/fulfillment/logic/{barrier,instance}.js` — Fan-In Barrier Multi-Owner Isolation, Scoped Keys & Peer Secret Protection
- **Root Cause**:
  1. `barrier.js` only read `owner.value` and ignored `owner.values: string[]`, causing multi-store callers to write `undefined` and match unowned/admin barriers (`undefined !== undefined` was `false`).
  2. `validateBarrierKey` used a flat global namespace `FULFILLMENT:BARRIER:${barrierKey}`, allowing cross-tenant key squatting.
  3. Non-admin callers could pass `onSettled: { target: 'local', method: '...' }` or unverified `onSettled.instanceId`.
  4. Both `instance.js` (`peer_rpc_with_callback`) and `barrier.js` (`dispatchOnSettled`) attached `config.peers[peer]` / `process.env.SOLO_PEER_*` credentials even when `action.endpoint` / `onSettled.endpoint` overrode the peer URL to an external host.
- **Fix**:
  - Added full multi-owner (`$owner.values`) support in `barrier.js`, scoping tenant barrier Redis keys under `${BARRIER_PREFIX}${owner.field}=${ownerVal}:${barrierKey}`.
  - Blocked non-admin callers from registering `onSettled.target = 'local'` and verified `instanceLogic.get({ id: onSettled.instanceId }, req)` at `barrier.create` time.
  - Guarded peer credential fallback in both `instance.js` and `barrier.js` (`canUseConfiguredCreds = !endpointOverride || endpointOverride === configuredEndpoint`).
  - Fixed `instance.reap` to use `matchesOwner(owner, i)`, fixed `instance.create({ idempotent: true })` backfill scan to match `ownerVal`, and reset `justSettled`/`settledNow` at the start of `optimisticUpdate` callbacks.

### 🔴 [P0-5], 🟠 [P1-1], 🟠 [P1-3], 🟡 [P2-1] — Entity Lock, SSRF IPv6 Canonicalization, Outbound Redirects & Agent Hardening
- **`api/library/entity.js` ([P1-1])**:
  - Locked `existingVal` in `stampOrValidateOwner` when `existingVal !== undefined` so `update()` cannot reassign a record's owner from `B01` to `B02` even for multi-owner callers; added `assertOwned(existing)` inside `optimisticUpdate`; blocked `$owner`-scoped callers from invoking `compact()` and rejected path-traversal (`..`) or null bytes in `archiveDir`.
- **`api/library/ssrf.js` & `outbound.js` ([P1-3])**:
  - Implemented `parseIpv6Words` in `ssrf.js` to normalize any IPv6 literal into 8×16-bit words before checking loopback (`0::1`, `::0:1`), unspecified, IPv4-mapped (`0:0:0:0:0:ffff:127.0.0.1`), IPv4-compatible (`::127.0.0.1`), NAT64 (`64:ff9b::/96`), 6to4 (`2002::/16`), Teredo (`2001:0000::/32`), link-local, ULA, multicast, and DNS-rebinding hostnames (`*.nip.io`, `*.sslip.io`, `*.xip.io`, `localtest.me`, `lvh.me`, `*.local`).
  - Hardened `outbound.js` to block HTTPS $\to$ HTTP redirect downgrades, case-insensitively strip all auth/signature/cookie headers on cross-origin redirects, and drop `reqBody` when crossing origins.
- **`api/library/peer-relay.js` & `api/core/agent/providers/{index,ollama,solo-peer}.js` & `deploy/seed-bots.js` ([P0-5], [P1-3], [P2-1])**:
  - Propagated `_meta.hop` by default in `peer-relay.js` when an incoming hop is present (`callOpts.propagateHop !== false`) and blocked recursive `solo-peer/solo-peer/...` model strings in `SoloPeerProvider`.
  - Blocked caller-supplied `model: "mock"` / `"mock/*"` in `ProviderFactory.resolveProviderType` when `NODE_ENV === 'production'` and `config.provider !== 'mock'`.
  - Sanitized and capped `options` (`num_ctx <= 32768`, `num_predict <= 8192`) in `OllamaProvider`.
  - Added JSON-serialized fallback for `depth > 16` and inline delimiter detection in `library/injection-detect.js`.
  - Replaced static 24h `solo-dev-admin` in `deploy/seed-bots.js` (and `deploy/scaffold/seed-bots.js`) with a random token (`EX: 300`) deleted before exit.
  - Updated `api/autocheck/static/security.js` to recursively walk `logic/` subdirectories.
