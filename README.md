# SOLO

> **S**wift · **O**rchestrated · **L**earning · **O**bjects

**Version 1.1.10**

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

14 services in total, registered in [`deploy/services.json`](deploy/services.json) (the single source of truth for what's real — CI checks every other doc against it):

**Gateway**
- **router** (8600) — the only entry point: auth, JSON-RPC dispatch, Ed25519-signed forwarding, async `_task` dispatch, method-level permission checks

**Core**
- **gateway** (8020) — outbound external-channel adapter (email/SMS/etc.)
- **ingress** (8070) — inbound external-webhook adapter (API-key auth + dedup)
- **mcp** (8091) — Model Context Protocol adapter; exposes approved orchestrator workflows as MCP tools for external AI clients
- **notification** (8040) — delivery worker with backoff retry + dead-letter queue
- **administrator** (8680) — system backend / single-admin model
- **user** (8710) — accounts, sessions, permit storage
- **agent** (8730) — AI provider hub (Gemini / Qwen / OpenAI), capability routing
- **nexus** (8740) — Sentinel registry (event-subscribed reactive AI agents) + event routing
- **orchestrator** (8820) — workflow template CRUD + execution, behind a review/approval gate

**Apps**
- **planner** (8030) — schedule + todo
- **fulfillment** (8050) — declarative state-machine fulfillment engine (JsonLogic)
- **approval** (8060) — SAP approval protocol (request → verify → confirm → reject)
- **storage** (8750) — content-addressable file storage (SHA-256)

### Clients
- **Mobile** — cross-platform mobile client
- **Desktop** — Tauri-based desktop application
- **Portal System** — system administration dashboard
- **Portal Operator** — operations dashboard (team-owned source, not overwritten on framework upgrades)

---

## Quick Start

```bash
# Start the development environment (auto-installs deps, starts Redis on 6699)
bash deploy/dev.sh
```

---

## Documentation

- **[Docs Index](docs/README.md)** — 全量地图:protocol 规范 · planning 台账 · runbook · reference
- [Technical Overview](docs/reference/overview.md) — 系统架构与设计决策(⚠️ 含产品愿景,注意区分已实现/设想)
- [Protocol Specs](docs/protocol/zh/) — API 协议规范(中文);先读 [治理协议总览](docs/protocol/zh/governance.md)
- [Planning](docs/planning/) — [VERSION](docs/planning/VERSION.md)(封板线) · [BACKLOG](docs/planning/BACKLOG.md)(滚动待办) · [security](docs/planning/security.md) · [toFix](docs/planning/toFix.md)

---

## Project Structure

```
solo/
├── api/
│   ├── router/          # API Gateway (main entry)
│   ├── library/         # Shared utilities (auth, entity, permit, jsonrpc, clock, etc.)
│   ├── core/             # Infrastructure services
│   │   ├── administrator/
│   │   ├── agent/
│   │   ├── gateway/
│   │   ├── ingress/
│   │   ├── mcp/
│   │   ├── notification/
│   │   ├── nexus/
│   │   ├── orchestrator/
│   │   └── user/
│   ├── apps/             # Generic, domain-agnostic applications
│   │   ├── approval/
│   │   ├── fulfillment/
│   │   ├── planner/
│   │   └── storage/
│   ├── sample/           # New-service scaffold — copy this to build service #15
│   └── autocheck/        # Static + simulation quality gate
├── portal/
│   ├── system/           # Admin portal
│   └── operator/         # Business portal
├── client/
│   ├── mobile/           # Mobile client
│   └── desktop/          # Desktop client (Tauri)
├── deploy/               # Dev scripts, build, services.json (source of truth for ports/services)
├── e2e/                  # Black-box integration harness
└── docs/                 # Documentation & protocol specs
```

---

## Evolution

Rather than a flat feature list, here's *why* each phase happened — the design questions that drove it. For the exact diff of every tagged release, see [`CHANGELOG.md`](docs/planning/CHANGELOG.md).

### v1.0 — Framework skeleton
The initial cut: Router API gateway, Entity Factory, a workflow orchestration engine, and AI-agent capability routing. Establishes the one non-negotiable rule everything else builds on: services never call each other directly — every cross-service interaction is mediated by the Router over JSON-RPC.

### v1.1.0 — From gateway to AI-automation platform
Design question: how do you let AI agents react to events and act semi-autonomously without losing human oversight? This release added the **nexus** event bus and **Sentinel** (event-subscribed reactive AI agents) with a declarative context-assembly + autorun loop; **ingress** for inbound webhooks; storage moved behind a pluggable OSS provider; **orchestrator** got its first approval gate (a workflow must be reviewed before it can run); **passport** gave external users an isolated identity (method wall + row-level scoping); and a quality-gate trio — `autocheck` static audit, CI, and an e2e harness — so none of the above could regress silently.

### v1.1.1 – v1.1.5 — Making orchestration trustworthy under failure
Once workflows could run unattended, the real question became: what happens when a step fails halfway, or the process crashes mid-run? This phase added idempotency keys (so a retried or redelivered step can't double-execute), synchronous Saga-style compensation (undo already-completed steps when a later one fails), crash-safe checkpointing + retry (a stalled run can resume instead of silently rotting), and a scaffold contract package so services built on SOLO inherit these guarantees by default.

### v1.1.6 – v1.1.8 — Opening the door to external users, safely
Design question: how do you let real external users self-register without turning every internal RPC method into an accidental public API? This phase shipped passport OTP self-issuance, tightened the public-method surface twice (down to a small, explicit whitelist), added device-bound session upgrades — and, because a security boundary is only as trustworthy as the tests watching it, eliminated the last flaky mechanisms in the full e2e suite so CI could actually be trusted as a gate.

### v1.1.9 – v1.1.10 — Closing architectural gaps, extending AI interop
A structural review surfaced several "grew independently, now inconsistent" issues in one pass — caches with no invalidation path, two hand-synced copies of the bot permission map, two sources of truth for service ports — all fixed in the same release. Alongside that: a minimal **actor-claim** mechanism closes a confused-deputy gap for event-triggered workflows (a workflow can require that whoever *triggered* it, not just the bot executing it, actually holds the permission); an **MCP adapter** exposes approved orchestrator workflows as tools any MCP-speaking AI client can call; a second round of prompt-injection detection was added at the ingress boundary; and Saga compensation became *durable* — resuming correctly across an orchestrator restart, not just within one process's lifetime.

### Since v1.1.10 (in progress on `main`)
Background `_task` dispatch now retries with backoff before giving up, instead of a single fire-and-forget POST that silently dropped work on transient failure. Orchestrator workflows gained a `deprecate`/`restore` lifecycle distinct from delete, so retiring a workflow that's been running in production leaves its own audit trail instead of being indistinguishable from discarding a draft that was never approved.

---

## License

[Apache License 2.0](LICENSE).
