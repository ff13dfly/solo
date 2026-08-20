# SOLO

> **S**wift · **O**rchestrated · **L**earning · **O**bjects

English | [简体中文](README.zh-CN.md)

---

## What is SOLO?

SOLO is a Node.js + Express 5 + Redis framework for building AI-native microservice systems: a unified gateway, entity factory, permissions, audit trail, workflow orchestration, and AI-capability routing.

It is **pure infrastructure — no business domain is baked in**. There's no CRM, ERP, or commerce logic here; SOLO gives you the substrate to build one. (Docs sometimes use domain names like `commodity`/`crm` as illustrative examples of what you'd build on top — see [`docs/README.md`](docs/README.md) for how the docs distinguish "implemented" from "illustrative".)

Each letter of the name is a design principle:

| | Principle | What it means |
|---|---|---|
| **S** | **Swift** | Rapid iteration, lightweight microservices, instant deployment. Move fast without breaking the data source of truth. |
| **O** | **Orchestrated** | Workflow engine, cross-service coordination, and state-machine-driven fulfillment. Services collaborate, not just coexist. |
| **L** | **Learning** | AI Agent at the core — vision recognition, semantic inference, intent routing, and event-reactive autonomous agents (nexus Sentinels). |
| **O** | **Objects** | Entity-first architecture. Everything is a structured, versionable, searchable object, managed through one Entity Factory. |

---

## Architecture at a Glance

```
┌─────────────────────────────────────────────────┐
│                   Clients                       │
│         Mobile · Desktop · Portals               │
└──────────────────┬──────────────────────────────┘
                   │ HTTPS (8600)
┌──────────────────▼──────────────────────────────┐
│              Router (API Gateway)                │
│  Auth · Ed25519-signed JSON-RPC dispatch ·        │
│  method-level permission checks · _task dispatch  │
└──────────────────┬──────────────────────────────┘
                   │
       ┌───────────┼───────────┐
       ▼           ▼           ▼
  ┌─────────┐ ┌─────────┐ ┌─────────┐
  │  Core   │ │  Apps   │ │  Agent  │
  │ Services│ │ Services│ │  (AI)   │
  └────┬────┘ └────┬────┘ └────┬────┘
       │           │           │
       └───────────┼───────────┘
                   ▼
            ┌────────────┐
            │   Redis    │
            │  (Storage) │
            └────────────┘
```

All services are declared in [`deploy/services.json`](deploy/services.json) — **the single source of truth**
for what exists and on which port. CI checks every other doc against it, so read it rather than a copy:

```bash
node -e "console.log(require('./deploy/services.json').map(s => s.name + ':' + s.port).join('\n'))"
```

**Gateway** — `router`, the only entry point: auth, JSON-RPC dispatch, Ed25519-signed forwarding,
async `_task` dispatch, method-level permission checks.

**Core** — infrastructure every system needs: outbound channels (`gateway`) and inbound webhooks
(`ingress`), accounts and permissions (`user`), AI provider routing (`agent`), the event bus and
its reactive agents (`nexus`), workflow templates behind a review gate (`orchestrator`), delivery
with retry and dead-lettering (`notification`), MCP interop (`mcp`), system backend (`administrator`).

**Apps** — generic, domain-agnostic building blocks: `planner`, `fulfillment` (declarative
state machine), `approval`, `storage` (content-addressable).

### Clients

- **Portal System** / **Portal Operator** — admin and operations dashboards. Operator is
  team-owned source: shipped once, never overwritten by framework upgrades.
- **Mobile** — cross-platform mobile client. **Desktop** — Tauri application.
- **Browser extension** — [`client/extension-kit/`](client/extension-kit/) is the framework half
  (transport with backoff, a persistent send queue that survives MV3 service-worker eviction,
  image normalization, session handling) plus a runnable sample. Your own extension lives in
  `client/extension/` and is never overwritten — the same split as `api/library` vs `api/apps`.

---

## Quick Start

```bash
# Start the development environment (auto-installs deps, starts Redis on 6699)
bash deploy/dev.sh
```

---

## Documentation

> 📖 The documentation linked below (protocol specs, planning ledger, runbooks) is written in Chinese (中文). This README is currently the only English-language entry point.

- **[Docs Index](docs/README.md)** — full documentation map: protocol specs · planning ledger · runbooks · reference
- [Technical Overview](docs/reference/overview.md) — system architecture and design decisions (⚠️ contains product vision — distinguish implemented vs. aspirational)
- [Protocol Specs](docs/protocol/zh/) — API protocol specifications (Chinese); start with the [governance protocol overview](docs/protocol/zh/governance.md)
- [Planning](docs/planning/) — [VERSION](docs/planning/VERSION.md) (release-scope boundary) · [BACKLOG](docs/planning/BACKLOG.md) (rolling backlog) · [security](docs/planning/security.md) · [toFix](docs/planning/toFix.md)

---

## Project Structure

```
solo/
├── api/         Router · shared library · core + app services · new-service scaffold · quality gate
├── portal/      Admin and operations dashboards
├── client/      Mobile · desktop · browser-extension kit
├── deploy/      Dev scripts, build, project scaffold, services.json (source of truth)
├── e2e/         Black-box integration harness
└── docs/        Protocol specs, planning ledger, runbooks
```

Service directories are not listed here on purpose — they change, and `deploy/services.json`
already names them. To build service #15, copy [`api/sample/`](api/sample/).

---

## Releases

Every tagged release has a [`CHANGELOG`](docs/planning/CHANGELOG.md) entry describing what it
brings and what — if anything — downstream projects must do. The history is not duplicated here;
a hand-kept copy only rots:

```bash
git tag | sort -V | tail -5          # recent releases
git describe --tags --abbrev=0       # current
```

Development follows trunk + tags: `main` stays backward-compatible (no method removals, no
narrowing of the public surface, library APIs only gain signatures), and breaking changes are
saved for v2. See [`docs/runbook/release-and-branching.md`](docs/runbook/release-and-branching.md).

---

## License

[Apache License 2.0](LICENSE).
