# Sample Service Test Definition (Template)

> **Reference**: See `../data.md` (to be created) for full field definitions, error codes, and business logic.
> **Scope**: This document defines the **Test Runner Schema** and **Complex Flow Scenarios** for AI generation.
> **Framework**: **Jest** is required for all test implementations.

## 0. AI Generation Prompt

When creating a new service, provide this prompt to the AI to generate the full test suite:

```text
Reference api/sample/tests/cases.md for the test architecture and methodology.
Combine with [api/your-service/data.md] for business logic definitions.
Create a complete test suite for [api/your-service] including:
1. utils/generate_yaml.js (Adapted for new entities)
2. utils/mock_data.js (Adapted for new detailed flow)
3. yaml cases (Generated via script)
4. jest scripts (unit, integration, concurrency, e2e)
```

## 1. Directory Structure

```text
api/<service>/tests/
├── cases.md              # Scenario definitions (Logic Flows)
├── cases/                # Data-Driven Test Cases (YAML)
│   ├── unit.yaml         # Functional checks (Generated)
│   ├── boundary.yaml     # Input validation/Constraints
│   ├── idempotency.yaml  # Replay safety
│   └── performance.yaml  # Latency/Throughput baselines
├── report/               # Test Execution Reports ({YYYYMMDDHHmm}.md)
├── utils/                # Utilities & Generators
│   ├── generate_yaml.js  # Generator Script
│   └── mock_data.js      # Mock Data Seeder
└── scripts/              # Jest Test Suites (run with `jest`)
    ├── unit.test.js      # Loads unit.yaml
    └── ...
```

## 2. Test Generation & Seeding

**Generate YAML Cases**:
```bash
node api/<service>/tests/utils/generate_yaml.js
```

**Seed Mock Data (for Manual UI/API Testing)**:
```bash
node api/<service>/tests/utils/mock_data.js
```

## 2.1 Test Report Requirements
After running the full test suite, a Markdown report must be generated in `api/<service>/tests/report/`.
*   **Filename Format**: `{YYYYMMDDHHmm}.md` (e.g., `202601081105.md`)
*   **Content Requirements**:
    *   **Header**: Execution Time, Total Duration, Status (Pass/Fail).
    *   **Summary**: Total Cases, Passed, Failed, Skipped.
    *   **Categories**: Granular stats per definition file (e.g., unit.yaml, boundary.yaml).
    *   **Details**: Table of failed cases with error messages.
    *   **Suites**: Breakdown by Test Script file.


## 3. YAML Case Schema

Used for `unit`, `boundary`, `idempotency`, and `performance` tests.

```yaml
- id: "Unique-ID"                 # e.g., POST-ADD-01
  method: "resource.action"       # JSON-RPC method
  desc: "Brief description"
  depends: ["PREV-ID"]            # Optional: Dependencies to run first
  setup:                          # Optional: Pre-condition setup
    method: "resource.add"
    args: { ... }
    count: 1                      # For bulk setup
  input:                          # Arguments for 'method'
    key: "value"
    ref: "${PREV-ID.result.id}"   # Dynamic reference
  expect:
    ok: true | false              # Expected success status
    error: "ERROR_CODE"           # Required if ok: false
    assert:                       # Validation rules
      - { field: "path.to.key", equals: "value" }
      - { field: "id", match: "^[a-z0-9]+$" }
      - { field: "list", type: "array" }
      - { field: "prop", notNull: true }
    maxLatencyMs: 300             # For performance tests
  teardown: "cleanup.method"      # Optional: Post-test cleanup
  repeat: 1                       # For idempotency (default 1)
  expectSequence:                 # For idempotency (sequence of results)
    - { ok: true }
    - { ok: false, error: "ERR" }
```

## 3. Complex Flow Scenarios (Markdown)

These scenarios involve multi-step state changes, race conditions, or business workflows that cannot be expressed purely in YAML.

### Integration (INTEG)

**INTEG-01: Lifecycle Flow**
1. **Create**: Entity A -> Entity B (Child).
2. **Action**: Perform business logic.
3. **Verify**: Entity states updated correctly.

**INTEG-02: Search & Filter**
1. **Setup**: Create N items.
2. **Search**: Filter by property.
3. **Pagination**: Verify limits and offsets.

---

### Concurrency (CONC)

**CONC-01: Race Condition Check**
*   **Action**: Parallel updates to same entity.
*   **Expect**: Consistent final state (Optimistic Locking or LWW).

---

### End-to-End (E2E)

**E2E-01: Full User Journey**

---

## 3. Code Coverage Policy

To ensure test quality, we aim for the following coverage goals.
*   **Goal**: 80% Statement Coverage for core logic (`logic/*.js`).
*   **Method**:
    *   **Unit Tests (White-box)**: Import logic modules directly and run `jest --coverage`.
    *   **Integration Tests (Black-box)**: Use `nyc` (Istanbul) to instrument the running service process.

## 4. Security Testing Rules

Security tests are treated as first-class citizens (Category `security.yaml`).

*   **Injection Tests**: Attempt to inject malicious payloads.
*   **Large Payloads**: Test limits.
*   **Fuzzing**: Send unexpected types.

---

## 5. Extending Test Suite

Developers can add custom tests that will be automatically included in the aggregated report.

### Method A: New YAML Suite (Recommended)
For standard request/response tests without complex logic.

1. Create `api/<service>/tests/cases/security.yaml`.
2. Update `api/<service>/tests/scripts/unit.test.js`:
   ```javascript
   const suites = ['unit.yaml', 'boundary.yaml', 'security.yaml']; // Add new file
   ```
3. Run tests. The report will show a new category "security.yaml".

### Method B: Custom Jest Script
For complex scenarios (Chaos Engineering, Race Conditions).

1. Create `api/<service>/tests/scripts/chaos.test.js`.
2. Write standard Jest tests:
   ```javascript
   describe('Chaos Monkey', () => { ... });
   ```
3. Run with Jest:
   ```bash
   npx jest ... scripts/unit.test.js scripts/chaos.test.js
   ```
4. The report will categorize results under the `describe` title or filename.

