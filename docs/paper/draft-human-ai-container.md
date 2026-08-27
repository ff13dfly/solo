# The Container Model: An Experience Report on Enforcing Standards Across Human–AI Software Units

> **Status: DRAFT v0.1 (2026-08-24), not submitted anywhere.**
> Author placeholder: Fuu (independent). Venue target: experience-report track
> (CHASE / CAIN / ICSE-SEIP / FORGE). 中文审阅指南见同目录 `README.md`。

## Abstract

AI coding assistants make it feasible for every member of a small organization
— including members who have never used a terminal — to own and operate a
complete software system. This creates a scaling risk that is organizational,
not technical: each AI, optimizing locally, invents its own
conventions, and the resulting systems cannot be governed, upgraded, or
federated. We describe the *container model*: an organizational pattern
whose unit of structure is not a person or a team but a **box** — a
**standardized, partially immutable software stack under accountable human
ownership, worked by however many humans and AI agents its role requires —
including, for automated roles, no humans in the daily loop at all**.
Borrowing its logic from the ISO
shipping container rather than from OS-level containerization, the model rests
on three mechanisms: (1) a **read-only zone** — framework code and contract
documents that upgrades overwrite wholesale, making the standard one with
consequences rather than a style guide; (2) an **upstream-first evolution
loop** — when work inside a box is blocked by the standard, the standard is
changed centrally through a documented feedback-and-triage process, never
patched locally; and (3) **per-turn governing documents** that constrain the
AIs' behavior before any code is written. We report ten weeks of measured experience
implementing this model in SOLO, an open-source AI-native microservice
framework, across seven derived production systems:
21 tagged framework releases, 31 written feedback reports of which 23
have been triaged and repeatedly upcycled into releases, a natural experiment
in which all five observed derived projects independently re-invented the
same missing governance artifact, and a case study of provisioning a
container for a colleague with no terminal experience. We distill six lessons
and argue that enforced invariance — not better prompting — is the missing
primitive for scaling AI-assisted development beyond one person.

**Keywords:** human–AI collaboration, AI-assisted software engineering,
platform engineering, software governance, multi-agent organizations,
experience report

---

## 1. Introduction

Large-language-model coding assistants have crossed a threshold: a single
person working with an AI can build and operate a production software system
end to end. The natural next step for a small organization is to give *every*
role — finance, marketing, product — its own system, run by that role's
humans and AIs, and to connect these systems later through a coordination
layer.

The moment an organization tries this, it hits a problem that is neither a
model-capability problem nor a prompting problem. Each AI, asked to build a
system, will make hundreds of small architectural decisions: how entities are
stored, how services talk to each other, how secrets are handled, what a
permission is. Left alone, N locally optimizing AIs produce N mutually
alien architectures.
Convention documents do not prevent this — an AI (or a person) can read a
style guide and still diverge, because *diverging has no consequences*. We
argue this is the head risk of scaling AI-assisted development, and that the
known industrial answer to it — platform engineering's "golden paths" [15,16]
— is necessary but not sufficient, because golden paths are advisory and are
designed for engineers inside one platform team's jurisdiction, not for
federated units that each own their whole stack.

This paper describes and evaluates a different pattern, which we call the
**container model** after the ISO intermodal container [13] — not after
OS-level containerization, with which it shares nothing but the word. The
shipping container succeeded for one reason: its specification did not bend
to its users. Sixty years of invariance is what made every port, crane, ship
and truck interoperable. The container model applies the same logic to
human–AI organizations:

- **The organizational unit is the box: a standardized stack under human
  ownership.** A box belongs to a role, not to a fixed head-count — it may
  be worked by one person with one AI assistant, by several humans and
  several AI agents at once, or, when the role is automated, by AIs alone
  with humans present only as owners. The box's owners control its data,
  its private services, its purpose. The box's frame — framework code, wire
  contracts, authoring rules — is identical across all boxes.
- **The frame is enforced, not advised.** A designated read-only zone is
  overwritten wholesale on every framework upgrade. A local modification to
  the frame is not a violation that a reviewer might catch; it is work that
  the next upgrade deletes. The standard has consequences, which is what
  makes it a standard rather than a suggestion.
- **The standard evolves upstream-first.** When real work inside a box is
  blocked by the frame, the box files a structured feedback report with the
  framework maintainer; the report is triaged; accepted changes ship in the
  next release to *all* boxes; the local workaround is then deleted. The
  standard is a living artifact with a documented evolution protocol.
- **AIs are governed per-turn, before code.** Each box carries governing
  documents that every AI working in it loads on every conversational turn
  — covering why the box exists, what data must be exportable, and what an
  AI must not propose — because the highest-impact AI failure modes occur
  before any file is edited.

We implemented this model in **SOLO**, an AI-native microservice framework
(Node.js/Express/Redis: unified signed gateway, entity factory, permission
and audit layers, workflow orchestration with human approval gates), and
operated it across **seven derived systems** built and run by humans
working with AIs — plus a trial box provisioned for a colleague who had
never used a terminal.

**Contributions.**

1. A precise articulation of the container model as an organizational
   pattern for human–AI units, and its distinction from adjacent patterns
   (all-AI software companies, golden paths, runtime agent governance)
   (§2, §6).
2. An implementation blueprint: the mechanisms by which SOLO makes the
   standard enforceable and evolvable — read-only zone semantics, upgrade
   divergence detection, a static contract gate wired into the AIs' editing
   loops, dual feedback channels including an anonymous runtime channel for
   AI agents themselves (§3).
3. Ten weeks of measured evidence: release and feedback-loop statistics, three
   traced feedback-to-release cases, a 5-of-5 natural experiment revealing a
   missing artifact in the standard itself, and a provisioning case study
   for a non-technical owner (§4).
4. Six transferable lessons, several of which contradicted our initial
   design intuitions (§5).

We do not claim a controlled evaluation; this is an experience report from a
single small organization, with the threats to validity that entails (§7).

## 2. The Container Model

### 2.1 The unit: a box with human ownership

The model's unit of organization is not a person, not an AI agent, and not a
team: it is the **box** — a complete, independently deployable software
stack instantiated from a shared scaffold, under accountable human
ownership. Humans own purpose, judgment, approval, and accountability; AIs
do construction and operation; the box is the jurisdiction they share.

How many humans and AIs work a box is deliberately left open: a box is an
**n-human, n-AI** unit, and on the human side n may be zero. One owner
conversing with one assistant is common in our deployment; so is the
opposite extreme — a box whose role is automated (scheduled collection,
event-driven reaction) and whose day-to-day operation involves no human at
all. Nothing in the model or the stack privileges either configuration.
The stack is multi-actor by construction: a user
service manages accounts, sessions and permits for any number of humans,
and the gateway admits any number of AI actors — interactive coding
sessions, scheduled collection agents, event-subscribed sentinels, and
external agents that bootstrap through the router's self-describing guide
or its MCP adapter (§3.4). Conversely, one human may own several boxes, and
in our deployment most boxes share one operator (§7). The one count that is
never zero is ownership: every box has an accountable human owner, even
when that owner never appears in its daily operation. What the model fixes
is not the head-count but the boundary: the box is the unit of ownership
and accountability, and cross-box interaction is mediated — boxes never
call each other's internals; a coordination layer (in SOLO's roadmap, a
cryptographically authenticated bridge mesh) federates them.

This is the inverse of the "AI software company" line of work
(MetaGPT [1], ChatDev [2], AgentMesh [3], CodePori [4]), which replaces the
humans on a team with role-played agents. In the container model every
node answers to real humans with real authority, however automated its
daily operation; what is standardized and replicated is the
*infrastructure*, not the people.

### 2.2 The standard: invariance with consequences

Each box is split into two zones:

- **`[Solo]` (read-only):** the framework bundle, shared libraries, contract
  documentation, authoring guides, static checkers, deployment scripts. On
  upgrade, these are **overwritten wholesale**.
- **`[Project]` (owned):** the box's own services, data, environment,
  purpose documents. Upgrades never touch them.

The read-only zone is documented to users primarily as an upgrade-safety
mechanism ("don't edit these files, the upgrade will clobber them"). Our
central claim is that its real function is **governance**: it is the only
mechanism in the system that guarantees N boxes stay mutually intelligible,
because it is the only rule whose violation carries an automatic cost. A
convention that can be locally overridden without consequence will be — by
an AI faster than by a person, because the AI makes more decisions per hour
and each one locally optimizes.

### 2.3 Evolution: upstream-first, with a paper trail

Invariance without an evolution path would make the standard a straitjacket.
The model therefore requires a protocol: when work inside a box is blocked
by the frame, the correct move is never a local patch to the read-only zone;
it is a **feedback report** to the standard's maintainer. Reports follow a
fixed structure — source and scenario; *evidence with provenance labels*
(first-hand measurement vs. second-hand citation vs. judgment); observed
behavior; root cause traced to file and line; proposals ranked by value; a
triage verdict filled in later. Accepted proposals ship in the next release
to every box; the reporting box then deletes its temporary workaround. A
workaround that must persist is explicitly marked and tracked as divergence
debt.

This is upstream-first open-source discipline [17] transplanted to an
organization's internal human–AI infrastructure — with one addition worth
naming: some of the feedback comes from the AIs themselves, at the moment
their task hits a wall (§3.4).

### 2.4 Governing AIs before code

The final mechanism addresses *when* AI misbehavior happens. Contract
checkers and coding guardrails trigger when code is edited. But in our
experience the highest-impact failures occur earlier: the AI proposes
features nobody asked for; creates five empty entity tables "to be ready";
stores irreproducible data with no export path. The model therefore places a
**per-turn governing document** in each box — loaded into every AI
session's context on every conversational turn, not on file-edit events —
stating the box's
purpose, its decision criteria, its data classes and their required
treatment, and the rule that framework-level friction goes upstream (§2.3)
rather than into local patches. Evidence that this artifact is load-bearing,
and initially missing from our own standard, appears in §4.3.

## 3. Implementation: SOLO

SOLO is an open-source AI-native microservice framework. This section
describes only the mechanisms that realize §2; the framework's general
architecture (14 services behind a single Ed25519-signing router with
method-level permissions, an entity factory with audit trails and
write-ahead logs, a declarative fulfillment engine, an orchestrator with
human approval gates and m-of-n signatures) is documented in the repository.

### 3.1 The box as artifact: scaffold and bundle

A box is instantiated by a scaffold script from a **single-file framework
bundle** (`solo.v{X}.js`) plus shared source directories (`library/`,
`sample/`, `autocheck/`), contract documentation (`docs/authoring/`), an
AI guardrail skill, and deployment scripts — all marked `[Solo]`. The
bundle is port-agnostic: a per-box services manifest decides which services
activate on which ports, so one immutable artifact serves every box.
Everything created inside the box — private services under `api/apps/`,
environment, seeds, the operator UI — is `[Solo]`-free and never touched by
upgrades.

### 3.2 Upgrade semantics and divergence detection

`upgrade.sh` replaces the read-only zone wholesale (deletions propagate) and
leaves `[Project]` files alone. For the gray zone — deployment scripts that
boxes legitimately customize — it compares the installed file against the
*previous* release's stock version: if unmodified, it is upgraded silently;
if modified, it is **not** overwritten, the new stock version is staged
alongside as `<name>.solo-{ver}.new`, and the upgrade report flags
`DIVERGED`. Divergence is thus never silent: it is either resolved by
merging or carried as visible, enumerated debt.

The mechanics have engineering antecedents we build on deliberately:
package managers already give dependency code overwrite-on-upgrade
semantics, and template updaters such as cruft and copier [24] propagate
scaffold changes into derived projects with drift detection. SOLO extends
the overwritten zone beyond code — to contract documentation, deployment
scripts, and the AI guardrail skills, all in-tree — and reframes the
semantics from a convenience (staying current with a template) to a
governance boundary (the standard is physically not the box's to edit).

### 3.3 The gate in the AI editing loop

A static contract checker (`autocheck`) verifies naming (`{service}.{entity}.{action}`),
wire-contract conformance, declaration/registration consistency, and
red-line rules (services must not call each other directly; all calls go
through the router). Crucially, it is wired into every AI's tool loop as a
post-edit hook: an AI cannot finish an edit that breaks the contract
without seeing the failure immediately. The standard is checked at the speed
the AIs work, not at review time.

### 3.4 Two feedback channels

The upstream-first loop (§2.3) has a human channel and a machine channel:

- **Human channel:** structured markdown reports in the framework repo's
  `docs/feedback/`, written by a box's humans after real friction; triage moves
  them to `done/` with a recorded verdict, whether or not the proposal was
  accepted.
- **Machine channel (`system.report`):** any AI agent operating against a
  box can *anonymously* file a "the system cannot do X" report through the
  router at the moment a task hits a wall. Reports are deduplicated;
  repeated collisions increment a counter, so triage priority is literally
  "how many tasks hit this wall." The router's self-describing guide
  teaches external agents that this channel exists.

### 3.5 Per-turn governance artifacts

Each box carries a root governing document (in our deployment, the AI
harness's `CLAUDE.md` convention) auto-loaded every turn, and a guardrail
skill that triggers on service edits. These are distinct instruments: the
skill governs *how code is written*; the root document governs *what should
exist at all* — and, as §4.3 shows, the two are not substitutes.

## 4. Experience and Evidence

**Setting.** One maintainer develops the framework; seven long-running
derived systems (project codenames: colony, finance, ladder, overview,
runner, trend, wavely/erp) are built and operated on scaffolded boxes —
plus an eighth box provisioned as a one-off trial for
a non-technical role (the §4.4 case study) — spanning organizational dashboards, financial tracking, trend
collection, job orchestration, and an ERP. Box populations vary and
overlap rather than forming one-to-one pairs: most boxes share a single
human operator, who owns several boxes at once; individual boxes are
worked by multiple AI actors (interactive sessions, scheduled collectors,
external agents arriving through the self-describing gateway, §3.4);
boxes with automated roles run most days with no human in the loop, their
humans appearing only as owner and occasional maintainer; and
the §4.4 box involved two humans in different roles, a provisioner and an
operator. The deployment topology spans a
home server, two VPSs, and developer machines. The framework's public
repository opened in July 2026; the observation window for the statistics
below is June 14 – August 24, 2026 unless stated otherwise.

### 4.1 The loop runs, and it converges upstream

Over the ten-week window the framework cut **21 tagged releases**
(v1.1.0 → v1.2.2). The feedback corpus holds **31 structured reports**, of
which **23 are triaged and archived** with recorded verdicts and 8 are
pending. Releases are traceable to reports; three cases illustrate the
loop's shape:

- **An agent-facing gap found by agents.** A derived project (wavely)
  reported that external AI agents could not bootstrap against a box
  without human hand-holding. Triage produced the framework's
  self-describing `system.guide` mechanism — anonymous first-call returns
  the authentication flow, envelope format and error codes — shipped in
  v1.1.11. The report that motivated it is archived verbatim.
- **A silent-failure class found by co-located boxes.** Two boxes sharing a
  machine (overview, trend) discovered that a Redis port collision fails
  *silently*: the second box attaches to the first box's database and
  corrupts it. The report traced the root cause and the fix class —
  startup checks must prove ownership, not just reachability, and must
  fail closed. The framework's launcher now verifies Redis ownership and
  refuses to start on another box's port; the same release hardened
  front-end port claiming from warn-and-continue to fail-fast.
- **Batch upcycling.** v1.1.16 closed out six derived-project reports in
  one release; v1.1.17 closed five more from a single project (colony).
  Upcycling is routine, not exceptional: it is the release train's main
  cargo.

Two observations. First, the reports' **evidence-provenance discipline**
(§2.3) earned its keep: triage caught at least one case where a derived
project's second-hand claim about router behavior was wrong (the router had
returned the correct count; an intermediate layer dropped it), which a
first-hand/second-hand label made cheap to detect. Second, the loop's cost
asymmetry matters: a report costs its author an hour; a silent divergence
costs the maintainer an unbounded amount later. The protocol prices this
correctly.

### 4.2 Enforced invariance is visible as version lag — and that is the cost

A snapshot across boxes (2026-08-15) shows bundle versions spanning
v1.0.0 to v1.1.15: boxes lag the standard's head by days to months.
Under the container model this is not drift — every box is on *some* exact
release of the same standard, divergence is enumerated (§3.2), and the
upgrade path is one file copy plus staged merges. But lag is real cost:
a box on an old bundle cannot use new framework switches (a derived
project needed the framework's Redis-password support and had to upgrade
its bundle first, because the alternative — editing the read-only launcher
— is exactly what the model forbids). We consider this trade explicit and
correct: the alternative to visible lag is invisible fork.

### 4.3 A natural experiment: 5 of 5 boxes re-invented the same missing artifact

The scaffold initially shipped the guardrail skill (§3.5) but **no root
governing document**. All five derived projects observed at the time had
independently written one by hand. Five out of five is not preference; it
is the standard revealing its own gap through its instances — precisely the
signal the feedback loop exists to carry, and it was duly reported upstream
with a proposal to ship a template. The episode also demonstrated §2.4's
distinction empirically: the skill (which triggers on service edits) could
not have prevented any of the failure modes the root documents were written
to stop — feature over-proposal, speculative schema creation, unexported
irreproducible data — because those happen before any service file is
edited.

### 4.4 Provisioning a box for a human with no terminal experience

The model's promise is that *every* role can own a box. We tested the
worst case: provisioning a box for a marketing colleague who had never used
a terminal. Result: feasible, with a sharp division found in practice —
the colleague could *operate* the box (converse with an AI assistant; the per-turn
governing document did the day-to-day governing), but could not *provision*
it: installing the runtime dependencies, allocating ports, generating keys
and validating Redis ownership all required judgment the colleague could
not supply. The working solution was to have an experienced machine
generate the complete box and deliver it. This works but does not scale
(every new person costs an expert a session), which converts "deployment
slimming" from an optimization into a feasibility precondition for the
model at organization scale — a prioritization insight we fed back into the
roadmap. The episode also showed the box, not a fixed human–AI pairing, to
be the durable unit: this box was provisioned by one human and is operated
day to day by another, and it changed hands without changing its frame.

### 4.5 What the model has *not* yet demonstrated

Honesty requires listing the unproven half. The coordination layer that
federates boxes (bridge mesh with narrow permits) is designed and
adversarially reviewed but not deployed; all cross-box questions today are
answered by humans. (As of this writing, a first same-operator testbed —
a loopback bridge between two co-located boxes — and a three-channel
asynchronous interaction protocol for it, downlink archival-acknowledgment
plus periodic pull plus doorbell, have entered specification; deployment
has not begun.) Governance of the *coordinator* itself — who may
change the upstream's permits, under what approval — is designed (routed
through the framework's m-of-n approval chain) but likewise undeployed. And
the model has run under one maintainer; we do not know how triage scales
when reports arrive from fifty boxes rather than seven.

## 5. Lessons

**L1 — A standard is a consequence, not a document.** Every mechanism that
actually held (read-only zone, fail-fast port claims, post-edit contract
gate) works because violating it costs something automatically. Every
mechanism that was advisory (docs describing conventions) was violated by
default, at AI speed. If a rule matters, wire a consequence to it; if you
cannot, expect divergence.

**L2 — Govern AIs per-turn, not per-edit.** The damaging failure modes
happen before code: proposing scope, inventing schemas, choosing what to
persist. Only an always-loaded governing document reaches that window;
edit-triggered guardrails structurally cannot (§4.3).

**L3 — Silent failure is the default failure mode of co-located boxes.**
Port collisions, inherited environment variables, wrong-database
attachments: none of these crash; all corrupt. Startup checks must prove
*ownership* and fail closed. We now treat "warn and continue" in a
launcher as a bug class.

**L4 — Label evidence provenance in feedback.** Requiring reports to mark
each claim first-hand / second-hand / judgment made bad upstreaming cheap
to catch (§4.1) and kept the standard's evolution anchored to measurements
rather than to telephone.

**L5 — Version lag is the honest price of no-fork.** Enforced invariance
converts what would be N invisible forks into N visible lags plus an
enumerated divergence list. Buy it knowingly: the lag is real, bounded,
and repayable; the forks are none of those.

**L6 — For non-technical owners, provisioning is the wall, not operation.**
With a per-turn governing document, a non-programmer can safely *drive* a
box on day one. Getting them a box is the hard part, and it is an
infrastructure problem (dependency slimming, prebuilt delivery), not a
prompting problem (§4.4).

## 6. Related Work

**All-AI software organizations.** MetaGPT [1], ChatDev [2], AgentMesh [3]
and CodePori [4] assign organizational roles to LLM agents and automate the
SDLC end to end. The container model inverts the premise: humans are not
simulated but retained as each node's accountable owners, and the
replicated artifact is the infrastructure standard, not the org chart.

**Human–AI teaming.** The HCI and organizational literature studies
task-level collaboration: trust [6], situation awareness [7], team design
and reviews [5,8]. It treats the infrastructure the humans and AIs work *inside* as
given; the container model is precisely about that infrastructure.

**Platform engineering and golden paths.** Industry practice equips
engineers — and recently agents [15,16] — with paved roads inside one
organization's platform. Recent academic treatments frame skills and
policies as agent-consumable institutional knowledge [10,11]. The closest
of these, Knowledge Activation [11], converts institutional knowledge into
an agent-traversable graph of atomic units and reports developer-experience
gains from a single-organization deployment; it standardizes the *knowledge
schema* consumed by agents, but the stack remains centrally operated —
there is no per-unit ownership, no enforced-invariance mechanism, and no
documented protocol by which the units' friction evolves the standard.
Golden paths generally are advisory and centrally operated; the container
model's standard is enforced by overwrite semantics and is designed for
federated units that each own a full stack.

**Organizational antecedents.** Enforced standards across autonomous units
are not new to organizations. Amazon's 2002 service-interface mandate — all
teams expose functionality only through service interfaces, on pain of
dismissal, as later documented by Yegge [20] — is enforced invariance for
team boundaries; Haier's *rendanheyi* model decomposes the firm into
thousands of self-managing microenterprises on a shared platform [19]. The
container model can be read as the human–AI-era descendant of both, with
two deltas: the autonomous unit shrinks to a single box — small enough for
one person to own, with no fixed bound on the humans and AIs working it —
and the enforcement mechanism moves from managerial policy into the
filesystem and upgrade semantics of the unit's own stack.

**Agent context files.** A recent empirical line studies the governing
documents themselves: large-scale characterizations of AGENTS.md/CLAUDE.md
files find them to be complex, config-like artifacts dominated by build and
architecture content [21,22], and controlled evaluations of their effect on
task success report mixed results [23]. That literature measures the files
as they are used in the wild — largely as *technical* context. Our §4.3
observation is complementary and different in kind: when boxes lacked a
root governing document, every box independently created one, and what
they put in it was not build context but *organizational* governance
(purpose, scope discipline, data policy) — content the task-success lens
does not measure.

**Runtime agent governance.** Governance-as-a-Service [9], Institutional
AI [12], and sovereign-agent infrastructure [14] govern agent *behavior* at
runtime with monitors, scores, and sanctions. The container model governs
the *substrate* statically and cheaply — filesystem semantics and upgrade
overwrites — and reserves runtime governance (approval gates, signatures)
for the actions that need it.

**End-user software engineering.** The vision of non-programmers owning
their software is classic [18] and newly practical with LLMs. Our
contribution to that line is narrow and empirical: the binding constraint
we observed is provisioning, not operation (§4.4, L6).

To our knowledge, the specific combination — the box as the organizational
unit binding humans and AIs, standard-with-consequences via a read-only zone,
upstream-first evolution fed partly by the AIs themselves, and per-turn AI
governance — has not been described or evaluated in the literature.

## 7. Threats to Validity

**Single organization, single maintainer.** All seven boxes and the
framework share one operator-culture; effects may not transfer. The
maintainer is also this paper's author: selection and confirmation bias are
live risks, which we mitigated only partially by anchoring every claim in
§4 to written artifacts (feedback reports, changelogs, tagged releases)
that predate the paper.

**Small N, no control.** Seven boxes, five in the §4.3 observation; no
baseline organization running the same projects without the container
model. The 5/5 result is suggestive, not statistical.

**Confounded timeline.** The observation window coincides with rapid
improvement in the underlying AI models; some outcomes attributed to the
model may partly reflect better AIs.

**Self-reported metrics.** Release and feedback counts are from the
repository and are auditable; qualitative claims (e.g., "silent failure is
the default failure mode") generalize from a small incident set.

## 8. Conclusion

The container model treats the scaling of AI-assisted development as a
standardization problem and borrows the shipping container's answer: make
the standard physically consequential, evolve it only upstream, and let
value come from invariance. Ten weeks and seven boxes in, the loop runs:
the standard absorbs its instances' lessons at a cadence of roughly two
releases a week, divergence is visible instead of silent, and a
non-programmer can drive a box on day one. The unproven half — federation
and coordinator governance — is where our work goes next. We offer the
pattern, its mechanisms, and our ledger of costs as a starting point for
others building organizations out of human–AI boxes.

## Acknowledgments and AI Disclosure

In keeping with the subject of this paper, the manuscript itself was
produced inside the model it describes: the text was drafted by a
generative AI assistant (Claude, Anthropic) working under the author's
direction inside one of the boxes described in §4, from the repository's feedback reports,
changelogs, and release history. The system design, all measurements, the
feedback corpus, and all judgments and conclusions are the author's; the
author reviewed and verified every claim against the primary artifacts and
takes full responsibility for the content. This disclosure follows the
ACM and IEEE policies on the use of generative AI in publications.

## References

[1] S. Hong et al. MetaGPT: Meta Programming for a Multi-Agent
Collaborative Framework. ICLR 2024. arXiv:2308.00352.

[2] C. Qian et al. ChatDev: Communicative Agents for Software Development.
ACL 2024. arXiv:2307.07924.

[3] AgentMesh: A Cooperative Multi-Agent Generative AI Framework for
Software Development Automation. arXiv:2507.19902.

[4] Z. Rasheed et al. CodePori: Large-Scale System for Autonomous Software
Development Using Multi-Agent Technology. arXiv:2402.01411.

[5] T. O'Neill, N. McNeese, A. Barron, B. Schelble. Human–Autonomy
Teaming: A Review and Analysis of the Empirical Literature. Human Factors,
2022.

[6] Collaborative Human-AI Trust (CHAI-T): A Process Framework for Active
Management of Trust in Human-AI Collaboration. Computers in Human Behavior:
Artificial Humans, 2025.

[7] Q. Zhang et al. Agent Teaming Situation Awareness (ATSA): A Situation
Awareness Framework for Human-AI Teaming. arXiv:2308.16785.

[8] B. Lou et al. Unraveling Human–AI Teaming: A Review and Outlook.
arXiv:2504.05755.

[9] Governance-as-a-Service: A Multi-Agent Framework for AI System
Compliance and Policy Enforcement. arXiv:2508.18765.

[10] The AI-Native Large-Scale Agile Software Development Manifesto.
arXiv:2605.07717.

[11] Knowledge Activation: AI Skills as the Institutional Knowledge
Primitive for Agentic Software Development. arXiv:2603.14805.

[12] Institutional AI: A Governance Framework for Distributional AGI
Safety. arXiv:2601.10599.

[13] M. Levinson. The Box: How the Shipping Container Made the World
Smaller and the World Economy Bigger. Princeton University Press, 2006.

[14] Sovereign Agents: Towards Infrastructural Sovereignty and Diffused
Accountability in Decentralized AI. arXiv:2602.14951.

[15] Platform Engineering for the Agentic AI Era. Microsoft All Things
Azure blog, 2026. (industry reference)

[16] AI Agents Need Platform Engineering, Too. platformengineering.com,
2026. (industry reference)

[17] K.-J. Stol and B. Fitzgerald. Inner Source — Adopting Open Source
Development Practices in Organizations: A Tutorial. IEEE Software, 32(4),
pp. 60–67, 2015. doi: 10.1109/MS.2014.77.

[18] A. J. Ko et al. The State of the Art in End-User Software
Engineering. ACM Computing Surveys, 43(3), Article 21, pp. 1–44, 2011.

[19] G. Hamel and M. Zanini. The End of Bureaucracy. Harvard Business
Review, 96(6), Nov–Dec 2018. (Haier's rendanheyi microenterprise model)

[20] S. Yegge. Stevey's Google Platforms Rant. Public post, 2011.
(documents Amazon's 2002 service-interface mandate; the original memo is
not publicly available)

[21] Agent READMEs: An Empirical Study of Context Files for Agentic
Coding. arXiv:2511.12884.

[22] On the Use of Agentic Coding Manifests: An Empirical Study of Claude
Code. arXiv:2509.14744.

[23] Evaluating AGENTS.md: Are Repository-Level Context Files Helpful for
Coding Agents? arXiv:2602.11988.

[24] cruft (cruft.github.io) and copier: project-template update tools
with drift detection. (industry reference)
