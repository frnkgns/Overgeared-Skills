<div align="center">

<img src="./assets/overgeared.png" alt="Overgeared Skills logo" width="240" />

# Overgeared Skills

### A modular development system for [OpenCode](https://opencode.ai/docs/)

**Less prompt noise. More deliberate engineering.**

Overgeared Skills gives OpenCode a focused operating system for planning, building,
reviewing, and learning from real software work.

[Explore the workflow](#workflow-at-a-glance) · [Browse the skills](#skills)

</div>

---

## The problem

Most agent setups solve one problem at a time: a giant instruction file, a
forgotten cleanup step, or a review that only happens when someone remembers.

That approach creates noise. Important rules compete with one another, context
gets lost between sessions, and the final review becomes an afterthought.

## The Overgeared Skills approach

Overgeared Skills keeps the always-loaded rules small and moves specialized workflows
into focused skills that are activated when they are relevant.

| Everyday problem | Overgeared Skills response |
| --- | --- |
| One oversized instruction file | Modular skills with clear triggers |
| Skills that only run when remembered | Semantic capability selection, not keyword matching |
| Work disappears between sessions | Continuous knowledge capture and active WIP |
| Long multi-part tasks | Bounded, skill-aware agent delegation |
| “It looked done” | Cleanup, QA, and explicit verification |
| Reviews happen too late | Read-only `/changes-review` and `/project-review` |
| Risky defaults | Read-only data access and guarded Git actions |
| Reports take too long | Consistent, evidence-based reporting |

> **The goal:** make good engineering behavior easier to repeat, not harder to remember.

## Orchestration

Overgeared Skills behaves as an orchestration layer rather than a folder of optional
instructions. For meaningful work it:

- inspects and learns an existing project before changing it, so new code
  matches the conventions already in the repository instead of a generic style;
- searches for an existing implementation before creating a component, route,
  query, or helper, and reuses it unless that would break correctness;
- infers which skills apply from the task itself, instead of waiting for a
  keyword or a named skill;
- delegates independent, substantial workstreams to agents when that genuinely
  helps, while the main agent stays the orchestrator;
- captures durable project knowledge as decisions become established, gated by
  a significance test so notes never become transcripts;
- keeps WIP current during substantial unfinished work, and pauses and resumes
  on plain language such as "hold on" or "let's continue";
- reassesses skills, agents, and knowledge as the task evolves instead of
  locking in the first routing decision;
- verifies before claiming success, and scales orchestration up with complexity
  and risk rather than running everything by default.

For a new project with no established structure, the same layer establishes a
framework-native, feature-oriented foundation first, so the first feature does
not become the architecture for everything else.

Explicit commands remain available for deterministic control. They are a manual
override, not the only way the workflow runs.

## Project memory

Overgeared Skills keeps a small, durable understanding of each project so a later session
does not rediscover what an earlier one already learned. Each project vault gets
a `project/` area:

```text
project/
├── overview.md    what this repository is
├── structure.md   layout, directory responsibilities, relationships
├── stack.md       verified runtime, frameworks, data layer, tooling
├── commands.md    verified install, dev, build, test, lint, type-check
└── state.md       identity, known roots, last verified revision
```

The behavior it enables:

```text
Recall first.
Verify second.
Explore only what is missing.
Update what changed.
```

Project memory is an optimization, never an authority. Current source code and
schema always win; when stored memory contradicts the repository, the code is
believed and the memory is corrected. Each note carries a `Last verified`
marker as a staleness hint, and those markers never trigger an automatic full
rescan. Ordinary feature work reads only the notes it needs and updates only
the note whose durable content changed.

Existing vaults keep working. The `project/` area is created lazily, on first
use, and no existing note is ever deleted or overwritten to add it. Project
memory is not a copy of the repository, not a replacement for verifying code,
not a conversation log, and not a reason to scan the whole project each time.

## Continuity memory

Context is temporary; the vault is durable. Overgeared Skills keeps enough state to answer
ordinary questions about previous work without relying on the conversation:

```text
work-in-progress/current.md   where we stopped and what is next
sessions/YYYY-MM-DD.md        what happened on a given day
changes/                      a meaningful completed change, with reason
attempts/                     a rejected approach, why it failed, what worked
architecture/decisions/       why an important choice was made
```

That means these work in plain conversation, with no command:

```text
"Brief me."                    "Where did we stop?"
"What did we do yesterday?"     "What is still unfinished?"
"Continue what we were doing."  "Why did we do it this way?"
"Didn't we try this before?"   "What changed this week?"
```

A briefing stays compact — latest work, completed, key decisions, issues and
discoveries, still in progress, next recommended step — and never presents an
older session as current when Git or WIP shows newer work. Git is evidence for
what changed; the notes hold the reasoning.

Three systems cooperate without duplicating each other:

```text
conversation â†’ compaction â†’ active working context
compaction â†’ work-in-progress or knowledge-vault when appropriate
```

- **Compaction** = short-term compressed memory. Reconstructable working recall,
  lowest authority, expires when work moves on.
- **WIP** = task continuity. Unfinished state, blockers, and the next action.
- **Knowledge Vault** = long-term project memory. Decisions, conventions, root
  causes, and meaningful discoveries.

Authority runs `current source code â†’ user instructions â†’ WIP â†’ Knowledge
Vault â†’ compacted context`. Compaction hands durable facts to the vault and
unfinished work to WIP, then keeps only the temporary remainder by pointer.
`/pause` separates state into those three buckets; `/resume` rebuilds from
WIP plus relevant vault notes plus current source rather than trusting an old
summary. A compaction or a closed session therefore does not lose the
engineering state.

## Memory retrieval

### The model looks things up itself

Nothing is injected into your prompt. No note text is ever appended to what you type, and
lookup is not something that runs behind your back.

When a task depends on prior decisions or past findings, the model resolves the project, reads
`memory-index.md`, opens only the notes that match, and stops as soon as it has enough. Those
reads are visible tool calls, not hidden context.

```text
you ask something
   â†’ the model decides whether prior knowledge is needed
   â†’ resolves this project's vault
   â†’ reads memory-index.md as a catalog
   â†’ opens only the matching notes
   â†’ verifies any claim against current source
```

This is deliberate. Injected excerpts are stored in the conversation and re-sent on every
later turn, which pays for the same content twice and puts text in the transcript you never
typed. Lookup you can see is lookup you can trust.

Lookup is deterministic: no embeddings, no vector store, no database, no external service.
The index is only ever a hint — a missing or stale one never hides a note.

### Three kinds of memory, three different jobs

| Layer | Scope | Holds | Lifetime |
| --- | --- | --- | --- |
| **Lookup** | one task | notes the model chose to open | gone when the task closes |
| **WIP** | one task | unfinished state, blockers, next action | until the task closes |
| **Durable memory** | one project | decisions, root causes, rejected attempts | permanent |

Lookup reads durable memory; it never writes to it. New knowledge is still captured
deliberately rather than automatically.

### Project scoping

Only the active project's vault is read. Notes from another project are never opened,
and neither are personal directories, unless you explicitly ask. Links that point outside
the resolved vault are ignored.

If your repository name and vault folder differ, point Overgeared Skills at the right place with a
`.project-agent.md` in the repository root:

```markdown
---
name: my-project
knowledge_root: ~/Documents/KnowledgeVault/my-vault-dir
---
```

Without it, every lookup silently misses.

### What it will not do

- It never appends anything to a prompt, under any setting.
- It does not read the vault wholesale. Notes are opened by relevance, and the index is a
  catalog rather than content.
- It does not replace reading source. Notes are prior evidence; confirm before you act.

---

Each vault keeps a small `memory-index.md` catalog: one line per topic, linking
to the canonical note with a one-line description. It answers "what knowledge
exists, and where is it?" without opening a single note, and never grows into a
second copy of the documentation.

Important canonical notes record where they came from and when they were last
verified. When memory disagrees with the repository, the code wins, the
situation is marked `STALE`, `CONTRADICTED`, `AMBIGUOUS`, `UNVERIFIED`, or
`HISTORICAL`, and the note is corrected. Two canonical notes never end up
contradicting each other.

"Overgeared Skills should become better at remembering without becoming heavier to use."

## Workflow at a glance

```text
        A clear request
              │
              â–¼
     Understand the change
 requirements · architecture
              │
              â–¼
          Plan and build
              │
              â–¼
        /changes-review
   when the implementation
      needs a review
              │
              â–¼
         /cleanup
  when the work is finished
              │
              â–¼
     /deployment-check
   before production
              │
              â–¼
        /git-push
   when you ask for it
```

`/project-review` is the optional deeper audit of an entire codebase, not
something expected on every feature. Overgeared Skills supports the full development loop
without forcing every workflow into every conversation.

## Quick start

Clone the repository, open it in OpenCode, and let the agent install Overgeared Skills
for you:

```bash
git clone https://github.com/frnkgns/GentJinSkills.git
cd GentJinSkills
opencode
```

Then enter this command in OpenCode:

```text
Install Overgeared Skills by following INSTALL.md
```

Overgeared Skills installs directly into OpenCode's existing runtime directories:

- `<user-home>/.config/opencode/AGENTS.md`
- `<user-home>/.config/opencode/command/`
- `<user-home>/.config/opencode/skills/`

Overgeared Skills keeps only lightweight installation metadata under:

```text
<user-home>/.config/opencode/.overgeared-skills/
```

```text
No duplicate Overgeared Skills source tree is retained after installation.
```

OpenCode detects your operating system and configuration paths, installs the
runtime files in place, preserves your existing setup, adds only the required
Knowledge Vault permission to the global configuration, and, with explicit
approval, renames a legacy `Documents/ObsidianVault` folder to
`Documents/KnowledgeVault` so Obsidian keeps pointing at the same vault. It
keeps no copies of anything and verifies the result. Restart OpenCode when it
finishes.

For path detection, conflict handling, updates, and troubleshooting, see
[INSTALL.md](INSTALL.md).

The cloned repository is not required after a successful installation and can be
deleted.

Run `/update-overgeared-skills` for normal updates. It uses `<user-home>/.config/opencode/.overgeared-skills/manifest.json` to refresh only Overgeared Skills-owned files, asks before replacing anything you modified yourself, removes stale Overgeared Skills-owned files the repository no longer contains, preserves your own skills and commands, retires an old `<user-home>/.config/opencode/GentJin/` folder if one is present, and re-checks the Knowledge Vault permission. It retrieves the current source from an existing clone when one is available, otherwise from a temporary checkout that it removes afterwards. No backup copies are kept.

## Commands

| Command | Use it when you want to... |
| --- | --- |
| `/install-overgeared-skills` | Install Overgeared Skills into your global OpenCode configuration. |
| `/update-overgeared-skills` | Update the installed Overgeared Skills copy from a newer repository state. |
| `/learn-skills` | Load the full text of every installed skill into context for routing questions and corpus audits. |
| `/setup-git-guardrails` | Install, verify, or remove the guardrail that blocks destructive git commands. Never installed automatically. |
| `/cleanup` | Finish current work with QA, cleanup, and a final report. |
| `/report` | Turn the current work into a clear, evidence-based report. |
| `/status` | See the branch, pending changes, active WIP, and open questions. |
| `/task` | Handle a general-purpose software or laptop task, with reusable workflow memory and `vscode` and `dev` branches. |
| `/deployment-check` | Analyze deployment readiness, report blockers and warnings, and suggest next steps without modifying the project until you approve. |
| `/changes-review` | Review the current changes and their impact radius without modifying the project until you approve fixes. |
| `/project-review` | After confirmation, perform a comprehensive read-only review of the entire relevant project and suggest improvements before any changes are made. |
| `/pause` | Bring the active WIP current, flush durable knowledge, and record one next action. |
| `/resume` | Reload the WIP and relevant knowledge, verify them against current source, and continue. |
| `/git-push` | Commit and push the current changes on a new branch, asking for approval first. |

Commands are intentionally short entry points into larger, repeatable
workflows. Commands and plugins now use the Overgeared Skills name. The
`gentjin_discovery` and `gentjin_release_notes` tool identifiers keep their
original names so existing tool contracts continue to work.

## Portability

Overgeared Skills is not OpenCode-only. The instructions are plain Markdown; only the
runtime and tooling around them are OpenCode-specific.

```text
PORTABLE CORE            OPENCODE ADAPTER
AGENTS.md                src/
command/*.md             registry/
skills/*/SKILL.md        plugins/
                         evals/ · scripts/ · docs/
                         test/ · schemas/ · guardrails/
                         package.json
```

A foreign harness installs the core and skips the adapter, and loses no
behavior, because no skill depends on the adapter to be understood. The shared
skill contract is one directory per skill containing `SKILL.md` with `name` and
`description` frontmatter, where `name` equals the directory name — the format
most agent harnesses already read.

```bash
npm run export:portable
```

This writes a ready-to-consume copy: the core plus `capabilities.json`, a
machine-readable catalog of every skill and command with the host capabilities
Overgeared Skills needs, and `INTEGRATION.md` with generated per-harness steps. Hosts need
`file-read`, `file-write`, and `shell`; `network`, an Obsidian-compatible vault,
and `git` are optional.

See [docs/portability.md](docs/portability.md) for the full contract.

### Harness compatibility

The instruction layer is not locked to OpenCode. `npm run harnesses` writes the project-local layout each supported host actually reads:

| Host | Reads | Generated |
| --- | --- | --- |
| OpenCode | `AGENTS.md`, `skills/` | already native |
| Claude Code | `CLAUDE.md` | `@AGENTS.md` import |
| Codex | `AGENTS.md` | already native |
| Cursor | `.cursor/rules/*.mdc` | rule with `alwaysApply` |
| Windsurf | `.windsurf/rules/` | rule with `trigger: always_on` |
| Gemini CLI | `GEMINI.md` | `@./AGENTS.md` import |
| GitHub Copilot | `.github/copilot-instructions.md` | pointer |
| Cline / Roo | `.clinerules/` | `@AGENTS.md` import |
| Aider | `CONVENTIONS.md` | pointer |

```bash
npm run harnesses                    # every project-scoped host
npm run harnesses cursor windsurf    # only these
```

`AGENTS.md` stays the single source of truth. Hosts that support an import get a one-line pointer, because a copied instruction file diverges the first time the source changes. Only the tiny pointer files are committed; the copied skill and command trees are ignored and regenerated, since they duplicate `skills/` and `command/` verbatim.

`.claude/skills/` is the highest-leverage one. OpenCode v2 discovers it as a compatibility path, so a single copy of the skills serves Claude Code and OpenCode at the same time.

Harnesses that install into your user profile rather than the repository are reported, not written, so nothing outside this directory changes without you asking.

## Skills

Each skill is a focused playbook. Overgeared Skills loads the relevant guidance instead
of asking the agent to remember every rule at once.

| Skill | Focus |
| --- | --- |
| `requirements-review` | Ambiguity, constraints, conflicts, and acceptance criteria before implementation. |
| `architecture-review` | Cross-module structural changes, boundaries, data flow, and new-project scaffolding. |
| `project-conventions` | Learn an existing codebase, follow its conventions, and reuse what already exists. |
| `refactoring-migration` | Staged execution of large refactors, data or contract migrations, dual-write, and flag lifecycle. |
| `frontend-review` | Responsive UI, accessibility, UX states, and frontend performance. |
| `backend-review` | Handlers, services, jobs, webhooks, async behavior, retries, and idempotency. |
| `database-review` | Queries, data layers, performance, failures, and migration safety. |
| `api-design` | Request/response contracts, validation, pagination, and versioning. |
| `integration-review` | Defects at the seams between layers and systems. |
| `systematic-debugging` | Root-cause workflow for broken behavior and regressions. |
| `incident-response` | Live production impact: severity, mitigation, rollback, timeline, and hotfix discipline. |
| `test-strategy` | Risk-driven decisions about what to test and at which level. |
| `security-review` | Authentication, authorization, secrets, input, and data integrity. |
| `performance-review` | Evidence-based measurement, bottlenecks, and safe optimization. |
| `dependency-review` | Dependency additions, upgrades, and replacement risk. |
| `deployment-readiness` | Build and CI, environment parity, migration safety, rollback, and secret exposure. |
| `review-orchestrator` | Shared engine behind the review commands; delegates to the skills above. |
| `cleanup` | Pre-merge QA, debugging, cleanup, and production readiness. |
| `git-workflow` | Guarded branches, commits, pull requests, and source control. |
| `work-in-progress` | Pause, resume, and preserve unfinished implementation work. |
| `compaction` | Condense older context into a lean working summary; route WIP and durable knowledge outward. |
| `knowledge-vault` | Project discovery and persistent knowledge in the Knowledge Vault. |
| `reporting` | Concise console reports and durable vault documentation. |

## Built for the whole lifecycle

### Before the work

- Discover the project and its existing knowledge.
- Check active WIP, open questions, and recent decisions.
- Read the project's `project/` memory first, then verify only the paths the
  task will touch.
- Start from the current source code rather than assumptions.
- Learn the existing conventions and search for an existing implementation
  before creating anything new.
- Use `requirements-review` and `architecture-review` when the request is
  ambiguous or the change is structural.

### During the work

- Keep the active context small and relevant.
- Use the right review skill at the right trust boundary.
- Preserve decisions, rejected approaches, and meaningful discoveries.
- Track temporary QA, test, debug, seed, mock, and fixture artifacts in the
  WIP ledger as they are created.
- Write or update the durable change audit as the task evolves — previous
  implementation, what changed, why, affected files, actual verification.

### Before handoff

- Review the diff and affected user flows.
- Check loading, error, empty, nullable, and failure states.
- Run the project's real test, lint, typecheck, and build commands.
- Remove temporary artifacts and unnecessary logs.
- Run `/changes-review` when the work needs a read-only second opinion before
  fixes.

### After the work

- Write an evidence-based report.
- Capture reusable knowledge where it belongs.
- Keep unfinished work visible with one clear next action.

## Change audit and push hygiene

Every task that modifies a project leaves a durable change audit in the
project's `changes/` folder, following the canonical template. The audit
records the previous implementation, what changed, why it changed, affected
files, and what was actually verified — so the repository's history stays
explainable later without relying on chat memory.

Before any GitHub push, a mandatory cleanup gate scans the diff for
task-created temporary artifacts: seed scripts, throwaway fixtures, scratch
test routes, mock data added for local QA, ad-hoc verification scripts, and
generated test output. These are removed or reverted before staging, and
verification is re-run after cleanup. The branch or PR description is then a
concise numbered list of real user-visible changes; the technical detail
stays in the change audit, not in the PR body.

## Safe by default

Overgeared Skills is designed to make the cautious path the easy path:

- Database access is read-only unless write access is explicitly authorized.
- Commits, pushes, merges, and history changes require an explicit request.
- Global OpenCode configuration is additive: Overgeared Skills adds only its required
  Knowledge Vault permission and never removes existing entries.
- The legacy `Documents/ObsidianVault` folder is renamed to
  `Documents/KnowledgeVault` only with explicit approval, and Obsidian's saved
  path is updated to follow it.
- Credentials and environment values stay out of the repository.
- Verification is reported honestly; checks are never claimed without evidence.
- A primary orchestrator agent that delegates implementation keeps no direct edit, shell,
  or Code Mode authority: `src/guardrails/orchestrator-guard.mjs` refuses those calls and
  refuses delegation outside the configured specialist list at `tool.execute.before`.
  Skill loading and answer-only self-performance remain instruction-level.
- Real application data is preferred over mock or placeholder data.
- Security and data-integrity checks are applied when the change warrants them.

## Repository map

```text
.
├── AGENTS.md                 Global behavior and project-agnostic rules
├── INSTALL.md                Agent-assisted installation runbook
├── command/                  Reusable slash commands
│   ├── changes-review.md
│   ├── cleanup.md
│   ├── deployment-check.md
│   ├── git-push.md
│   ├── install-overgeared-skills.md
│   ├── learn-skills.md
│   ├── pause.md
│   ├── project-review.md
│   ├── report.md
│   ├── resume.md
│   ├── setup-git-guardrails.md
│   ├── status.md
│   ├── task.md
│   └── update-overgeared-skills.md
├── skills/                   Focused, trigger-based workflows
│   ├── api-design/
│   ├── architecture-review/
│   ├── backend-review/
│   ├── cleanup/
│   ├── compaction/
│   ├── database-review/
│   ├── dependency-review/
│   ├── deployment-readiness/
│   ├── frontend-review/
│   ├── git-workflow/
│   ├── incident-response/
│   ├── integration-review/
│   ├── knowledge-vault/
│   ├── performance-review/
│   ├── project-conventions/
│   ├── refactoring-migration/
│   ├── reporting/
│   ├── requirements-review/
│   ├── review-orchestrator/
│   ├── security-review/
│   ├── skill-authoring/
│   ├── systematic-debugging/
│   ├── test-strategy/
│   └── work-in-progress/
├── schemas/                   Portable JSON Schema contracts
│   ├── task-record.schema.json
│   └── task-event.schema.json
├── guardrails/                Opt-in git guardrail plugin, not auto-installed
├── src/                       Enforcement layer (Node 24, zero dependencies)
│   ├── schema/validate.mjs    JSON Schema subset validator
│   ├── task/record.mjs        Lifecycle, states, action capture
│   ├── task/completion-gate.mjs
│   ├── routing/route.mjs      Routing, scope and capability contracts
│   ├── memory/vault.mjs       Vault scanning, parsing, link extraction
│   ├── memory/failure-awareness.mjs
│   ├── plugin-api.mjs         Plugin.define with an identity fallback
│   ├── trace/writer.mjs       JSONL traces, redaction, coverage
│   ├── trace/plugin-body.mjs  Trace plugin implementation
│   ├── trace/plugin-support.mjs
│   ├── guardrails/git-guardrails.mjs
│   └── guardrails/orchestrator-guard.mjs
├── registry/
│   ├── skills.json            Generated skill contracts
│   └── capabilities.json      Unified skill + command catalog
├── plugins/
│   ├── overgeared-skills-capabilities.ts  Capability loader and discovery gate
│   └── overgeared-skills-trace.js         Trace plugin using real OpenCode hooks
├── src/                       Enforcement layer (Node 24, zero dependencies)
│   ├── schema/validate.mjs    JSON Schema subset validator
│   ├── task/record.mjs        Lifecycle, states, action capture
│   ├── task/completion-gate.mjs
│   ├── routing/route.mjs      Routing, scope and capability contracts
│   ├── memory/vault.mjs       Vault scanning, parsing, link extraction
│   ├── memory/failure-awareness.mjs
│   ├── capabilities/          Registry, resolution, loader, adherence state
│   ├── discovery/             Project resolution and discovery readiness gate
│   ├── release/               Release-notes collection, rendering, vault save
│   ├── trace/writer.mjs       JSONL traces, redaction, coverage
│   ├── trace/plugin-body.mjs  Trace plugin implementation
│   ├── trace/plugin-support.mjs
│   ├── guardrails/git-guardrails.mjs
│   ├── guardrails/orchestrator-guard.mjs
│   └── plugin-api.mjs         Plugin.define with an identity fallback
├── scripts/
│   ├── build-registry.mjs
│   └── build-capabilities.mjs
├── evals/                     Executable evaluation suite
│   ├── run.mjs                Contract and live modes
│   ├── cases.mjs
│   ├── workflow-scenarios.mjs 14 roadmap scenario checks
│   ├── graders/index.mjs
│   ├── scenarios/             Scenario definitions
│   └── fixtures/              Synthetic, non-secret data only
├── test/                      Unit and contract tests
├── docs/
│   ├── architecture.md
│   └── deferred.md
└── opencode.jsonc             Local OpenCode configuration (not installed)
```

## Verifying an installation

```bash
node --test "test/**/*.test.mjs"   # unit and contract tests
node evals/run.mjs                 # contract evaluation, deterministic
```

Both exit 0 on success. `node evals/run.mjs --mode live` runs the scenarios
through a real model and needs credentials; it is not part of the default check
and its results are never merged with contract results.

Also confirm the **runtime layer** is actually installed, not just the instruction layer.
Skills and commands can look perfect while every plugin is missing:

```bash
ls ~/.config/opencode/plugins ~/.config/opencode/src    # both must be non-empty
```

Then confirm the plugin loaded:

- `overgeared_skills_capability`, `gentjin_discovery`, and `gentjin_release_notes` appear as
  available tools.
- The server log at `~/.local/share/opencode/log/opencode.log` contains no
  `message="failed to load plugin"` line whose `target=` names an Overgeared Skills plugin.

`opencode plugin list` will not help here: it lists only *package* plugins, so local files
under `plugins/` never appear in it. Filtering the log on the words "failed to load plugin"
alone also over-matches, because OpenCode logs your own shell commands; match on `target=`
as well.

## Contributing

Improvements are welcome when they make the system clearer, safer, or more
useful:

- Keep skills focused on one recognizable trigger or outcome.
- Write descriptions that explain both **what** the skill does and **when** it
  should be used.
- Avoid secrets, machine-specific paths, and generated artifacts.
- Preserve the project's existing conventions before adding new ones.

Open an issue or pull request with a focused proposal and a short explanation
of the problem it solves.

<div align="center">

**Build with context. Review with rigor. Remember what matters.**

</div>
