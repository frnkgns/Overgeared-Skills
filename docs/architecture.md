# Architecture

Overgeared Skills has two layers with different failure modes. Confusing them is the main way to overstate what the system does.

## Instruction layer

The Markdown in `AGENTS.md`, `skills/*/SKILL.md`, and `command/*.md`. This layer tells the model what good behavior looks like. It is advice. The model can ignore it, and nothing detects that.

## Enforcement layer

The JavaScript in `src/` and `evals/`. This layer can refuse a completion, flag a scope violation, bound a retry, and record what actually happened. It runs regardless of whether the model cooperates.

A control belongs in the enforcement layer only when a hook supplies real evidence behind it. Anything else stays in the instruction layer and must be described as advisory.

## Runtime

| Component | Path | Responsibility |
| --- | --- | --- |
| OpenCode 2.0.28 | external | Model runtime, tools, execution, plugin hooks |
| Overgeared Skills trace plugin | `plugins/overgeared-skills-trace.js` | Records traces from real hooks |
| Overgeared Skills capability plugin | `plugins/overgeared-skills-capabilities.ts` | Registers `overgeared_skills_capability`, the discovery gate, and adherence checks |
| Trace writer | `src/trace/writer.mjs` | JSONL append-only events, redaction, coverage |
| Task record | `src/task/record.mjs` | Lifecycle, states, transitions, action capture |
| Completion gate | `src/task/completion-gate.mjs` | Rejects unsupported completion |
| Validator | `src/schema/validate.mjs` | Zero-dependency JSON Schema subset |
| Registry | `registry/skills.json` | Generated skill and capability contracts |
| Router | `src/routing/route.mjs` | Inspectable routing decisions, scope checks |
| Memory | `src/memory/vault.mjs`, `src/memory/search.mjs`, `src/memory/failure-awareness.mjs` | Vault walking, local lexical (BM25) search, retry bounding, failure retrieval, redaction |
| Eval runner | `evals/run.mjs` | Contract and live modes, metrics, exit codes |

## Schemas

`schemas/task-record.schema.json` defines one task. `schemas/task-event.schema.json` defines one trace event. Both are portable JSON Schema documents, so any tool can read them. The executable validator in `src/schema/validate.mjs` enforces the same rules in JavaScript, because Node has no built-in JSON Schema validator and `ajv` exists only inside OpenCode's bundle where it cannot be imported.

Two fields carry the honesty guarantees:

- `source` on both records must be `observed` or `asserted`. An asserted claim is never silently promoted to an observation.
- `routing.basis` must be `observed`, `inferred`, or `user_specified`. Because skill selection fires no hook, the completion gate rejects `observed` unless a first-class event backs it.

## Verified integration surface

Verified against the installed binary at `node_modules/opencode-ai/bin/opencode.exe` and cross-checked against official documentation. Both sources agree.

Hooks used: `tool.execute.before`, `tool.execute.after`, `chat.message`, `config`, `event`, `auth`, `install`, `shell.env`, `permission.ask`.

CLI used: `opencode run` for non-interactive execution, `opencode serve` for a headless server, `opencode export` for session JSON, `opencode stats` for token and cost data, `--pure` to run without external plugins.

Plugins load from `~/.config/opencode/plugins/` and `.opencode/plugins/`, plus the `plugin` array in config. All hooks run in sequence.

## What the hooks make possible

`tool.execute.before` and `tool.execute.after` observe genuine tool invocations. The plugin times them itself, so `duration_ms` is measured and never estimated. `tool.execute.before` can throw, which is the documented pattern for refusing an action, so a completion gate can be enforced rather than advised. `event` exposes the runtime event bus. `opencode run` makes live evaluation feasible and `--pure` provides a real baseline where Overgeared Skills is absent.

## Known limitations

Skill selection is not observable. No hook fires when the model loads a skill. Routing can only be inferred from which `SKILL.md` files are read, so every routing metric is labeled inferred.

No hook exposes model reasoning. Reasoning quality is out of reach for automated grading.

Tokens and cost are available from `opencode stats` and session export, not from a hook payload. Absent usage data is recorded as `unavailable` or `null`, never as zero.

`duration_ms` is unavailable for events that did not pass through the plugin. The trace schema forbids a negative duration, and the integrity check rejects an observed executed action with no measured duration.

Traces default to `~/.local/state/overgeared-skills/traces`, outside any Git-tracked repository. `OVERGEARED_SKILLS_TRACE_DIR` overrides this and a test asserts that an override pointing inside the repository is detected as unsafe.

Contract tests validate schemas, rules, redaction, and graders. They do not demonstrate live agent performance, and the runner prints that distinction on every run.

## Data flow

```text
OpenCode hooks -> overgeared-skills-trace plugin -> TraceWriter -> redacted JSONL
                                        |
task request -> Router -> skill selection (inferred)
                     |
                     v
              TaskRecord -> CompletionGate -> accept or downgrade
                     |
                     v
                  vault notes
```

## Commands

```bash
node --test "test/**/*.test.mjs"   # 79 unit and contract tests
node evals/run.mjs                 # contract evaluation, deterministic
node evals/run.mjs --mode live     # live runs, needs credentials, costs money
node evals/run.mjs --baseline      # --pure comparison, Overgeared Skills disabled
node scripts/build-registry.mjs    # regenerate registry/skills.json
```

Exit codes from the runner: `0` all checks passed, `1` at least one failed, `2` runner error.