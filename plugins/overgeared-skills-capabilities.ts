/**
 * Makes Overgeared Skills capabilities loadable and enforceable at runtime.
 *
 * Registers `overgeared_skills_capability`, which returns the complete canonical body of a skill or
 * command; a tool.execute.before hook that refuses workflow-owned commands until those
 * instructions are loaded; and an event subscription that checks adherence when the turn ends.
 *
 * OpenCode 2.0.28 requires the default export to be a definition object carrying an `id` and an
 * `effect` or `setup` function. A V1 plugin exported an async function returning a hook map, and
 * V2 rejects that shape outright, so both plugins failed to load. This file implements the V2
 * contract directly rather than importing `Plugin.define` from `@opencode/plugin`: define is an
 * identity function, so importing it would add six transitive packages for no behavior, and the
 * plugin still has to be validated against the release it targets.
 *
 * The V2 context exposes no session id, so the session observed on each hook event becomes the
 * identity used for discovery state, the gate, and the plugin-owned tools.
 */
import { appendFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { createLoader, type CapabilityLoader } from "../src/capabilities/loader.mjs"
import {
  beginSession,
  createDiscoveryState,
  declareScope,
  evaluateGate,
  noteRead,
  noteReadFailure,
  readinessFor,
  recordFor,
  recordMemory,
  startDiscovery,
  type DiscoveryState,
} from "../src/discovery/gate.mjs"
import { resolveProject } from "../src/discovery/resolve.mjs"
import { isAuthorizedVaultRoot, searchNotes } from "../src/memory/search.mjs"
import {
  collectChanges,
  defaultBranch,
  hasEligibleChanges,
  resolveBoundary,
  resolveTarget,
  suggestVersion,
} from "../src/release/collect.mjs"
import { renderReleasePackage } from "../src/release/render.mjs"
import { saveReleaseNote } from "../src/release/vault.mjs"
import { createGateTracer, readGateTrace, summarizeAdvisoryMisses } from "../src/discovery/gate-trace.mjs"
import type { GateTracer } from "../src/discovery/gate-trace.mjs"
import { evaluateOrchestratorGuard } from "../src/guardrails/orchestrator-guard.mjs"

const SHELL_TOOLS = new Set(["bash", "shell"])

interface PluginInput {
  project?: string
  theme?: string
  intro?: string[]
  items?: { title?: string; detail?: string }[]
  why?: string
  projectContext?: string
  limitations?: string[]
  breaking?: string[]
  repository?: string
  id?: string
  kind?: string
  action?: string
  paths?: string[]
  notes_read?: string[]
  no_relevant_notes?: boolean
  searched?: string[]
  failed?: boolean
  reason?: string
}

interface ToolInput {
  filePath?: string
  command?: unknown
}

interface ToolHookEvent {
  tool?: string
  sessionID?: string
  agent?: string
  input?: unknown
  status?: "completed" | "error"
  result?: unknown
  error?: unknown
}

interface GuardOwner {
  capability: { id: string }
}

interface GuardVerdict {
  guarded: boolean
  owners?: GuardOwner[]
}

interface ServerEvent {
  type?: string
  properties?: unknown
}

interface ToolEditor {
  add(tool: {
    name: string
    description: string
    input: Record<string, unknown>
    execute(args: PluginInput): Promise<{ content: string }>
  }): void
}

interface PluginContext {
  location?: { directory?: string }
  tool: {
    transform(callback: (editor: ToolEditor) => void): Promise<unknown>
    hook(
      name: "execute.before" | "execute.after",
      callback: (event: ToolHookEvent) => Promise<void> | void,
    ): Promise<unknown>
  }
  event: {
    subscribe(options?: { signal?: AbortSignal }): AsyncIterable<ServerEvent>
  }
}

function resolveOpenCodeRoot(): string {
  if (process.env.OVERGEARED_SKILLS_ROOT) return process.env.OVERGEARED_SKILLS_ROOT
  const here = dirname(fileURLToPath(import.meta.url))
  return resolve(here, "..")
}

export default {
  id: "overgeared-skills",

  async setup(ctx: PluginContext) {
    const loader: CapabilityLoader = createLoader({ opencodeRoot: resolveOpenCodeRoot() })
    const discovery: DiscoveryState = createDiscoveryState()
    const resolution = resolveProject(ctx?.location?.directory ?? process.cwd())
    const tracer: GateTracer = createGateTracer()

    let activeSession: string | undefined

    const sessionFor = (observed?: string): string => {
      const sessionId = observed ?? "default"
      if (!discovery.sessions.has(sessionId)) beginSession(discovery, sessionId, resolution)
      return sessionId
    }

    const currentSession = (): string => sessionFor(activeSession)

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "overgeared_skills_capability",
        description:
          "Load the complete canonical instructions for a skill or command in Overgeared Skills before performing any action it governs. " +
          "Use this whenever an Overgeared Skills workflow applies and you need its full body rather than its summary. " +
          "Examples: id update-overgeared-skills, install-overgeared-skills, git-push, systematic-debugging. " +
          "Pass kind as command, skill, or reference when you know it. " +
          "A skill may advertise reference ids for its deferred detail; load one only when the active " +
          "workflow actually needs that section.",
        input: {
          type: "object",
          properties: {
            id: { type: "string", description: "Capability id, for example update-overgeared-skills, systematic-debugging, or knowledge-vault-templates" },
            kind: { type: "string", description: "Optional: command, skill, or reference" },
          },
          required: ["id"],
          additionalProperties: false,
        },
        async execute(args: PluginInput) {
          const result = loader.load(args?.id, args?.kind)
          if (!result.ok) return { content: `CAPABILITY_UNAVAILABLE: ${result.reason}` }
          const header = `# ${result.id} (${result.kind}) - canonical instructions loaded from ${result.path}`
          const references = result.references ?? []
          const footer = references.length > 0
            ? `\n\nDeferred detail available as references: ${references.join(", ")}. Load one with overgeared_skills_capability only if this workflow needs it.`
            : ""
          return { content: [header, "", result.instructions, footer].join("\n") }
        },
      })

      editor.add({
        name: "gentjin_release_notes",
        description:
          "Prepare release notes for the current repository from verified Git history. " +
          "Action 'collect' returns the target, previous boundary, collected changes and a proposed " +
          "version so you can write accurate prose. Action 'render' takes your theme, intro, items " +
          "and notes, renders the Markdown and saves it into this project's knowledge root. " +
          "This never creates a tag, a release or a pull request, and never publishes anything.",
        input: {
          type: "object",
          properties: {
            action: { type: "string", description: "collect | render" },
            project: { type: "string", description: "Project name used in the rendered title, for action render" },
            theme: { type: "string", description: "Short release theme, for action render" },
            intro: { type: "array", items: { type: "string" }, description: "One or two short paragraphs, for action render" },
            items: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  title: { type: "string" },
                  detail: { type: "string" },
                },
                additionalProperties: false,
              },
              description: "Change items as { title, detail }, for action render",
            },
            why: { type: "string", description: "Why this release matters, for action render" },
            projectContext: { type: "string", description: "Verified project context, for action render" },
            limitations: { type: "array", items: { type: "string" }, description: "Short limitation statements, for action render" },
            breaking: { type: "array", items: { type: "string" }, description: "Breaking change statements, for action render" },
            repository: { type: "string", description: "Repository URL, for action render" },
          },
          required: [],
          additionalProperties: false,
        },
        async execute(args: PluginInput) {
          const action = args?.action ?? "collect"
          const root = resolution.project_root
          const target = resolveTarget(root, "HEAD")
          const boundary = resolveBoundary(root, target)
          const items = boundary.sha ? collectChanges(root, boundary.sha, target.sha) : []

          if (action === "collect") {
            return {
              content: JSON.stringify(
                {
                  project_root: root,
                  knowledge_root: resolution.knowledge_root,
                  branch: defaultBranch(root) ?? target.branch,
                  target_sha: target.sha,
                  previous_boundary: boundary.tag,
                  previous_boundary_selected: Boolean(boundary.selected),
                  previous_boundary_verified: Boolean(boundary.verified),
                  previous_release_published: Boolean(boundary.publication?.verified),
                  boundary_warning: boundary.warning,
                  eligible_changes: hasEligibleChanges(items) ? items.length : 0,
                  items,
                  proposed_version: suggestVersion(root, items),
                },
                null,
                2,
              ),
            }
          }

          const pkg = renderReleasePackage({
            project: args?.project ?? resolution.identity,
            theme: args?.theme,
            repository: args?.repository,
            projectContext: args?.projectContext,
            intro: args?.intro ?? [],
            items: args?.items ?? [],
            why: args?.why,
            limitations: args?.limitations ?? [],
            breaking: args?.breaking ?? [],
            target,
            boundary,
            version: suggestVersion(root, items),
            evidence: items.map((i) => ({ kind: "commit", reference: i.key, subject: i.subject })),
          })

          const saved = saveReleaseNote({ knowledgeRoot: resolution.knowledge_root, pkg })

          return {
            content: JSON.stringify(
              {
                saved: saved.ok,
                path: saved.path ?? null,
                save_error: saved.ok ? null : saved.error,
                updated_in_place: Boolean(saved.updated),
                proposed_title: pkg.title,
                release_url: pkg.releaseUrl,
                previous_boundary: pkg.previousBoundary,
                previous_release_published: pkg.previousReleasePublished,
                boundary_advanced: pkg.boundaryAdvanced,
                created_tag: pkg.createsTag,
                created_release: pkg.createsRelease,
                published: pkg.published,
                body: pkg.body,
              },
              null,
              2,
            ),
          }
        },
      })

      editor.add({
        name: "gentjin_discovery",
        description:
          "Record and inspect verified project discovery for this session. Actions: " +
          "'resolve' returns the resolved project root, identity and knowledge root; " +
          "'scope' declares the files the task intends to change; " +
          "'memory' records the memory retrieval result (notes_read, or no_relevant_notes); " +
          "'status' reports current readiness. Project edits are blocked until readiness is ready.",
        input: {
          type: "object",
          properties: {
            action: { type: "string", description: "resolve | scope | memory | status" },
            paths: { type: "array", items: { type: "string" }, description: "Files the task intends to change, for action scope" },
            notes_read: { type: "array", items: { type: "string" }, description: "Memory notes actually read, for action memory" },
            no_relevant_notes: { type: "boolean", description: "True when no note applies, for action memory" },
            searched: { type: "array", items: { type: "string" }, description: "Vault areas actually searched this session, required with no_relevant_notes" },
            failed: { type: "boolean", description: "True when retrieval genuinely failed, for action memory" },
            reason: { type: "string", description: "Why retrieval failed, only when failed is true" },
          },
          required: ["action"],
          additionalProperties: false,
        },
        async execute(args: PluginInput) {
          const action = args?.action ?? "status"
          const sessionId = currentSession()

          if (action === "resolve") {
            return { content: JSON.stringify(startDiscovery(discovery, sessionId), null, 2) }
          }

          if (action === "scope") {
            const paths = declareScope(discovery, sessionId, args?.paths ?? [])
            const active = recordFor(discovery, sessionId)
            if (active) active.source_areas = paths.map((p: string) => dirname(p))
            return { content: JSON.stringify({ intended_paths: paths }) }
          }

          if (action === "memory") {
            const result = recordMemory(discovery, sessionId, {
              status: args?.failed ? "error" : "ok",
              notes_read: args?.notes_read ?? [],
              no_relevant_notes: args?.no_relevant_notes === true,
              searched: args?.searched ?? [],
              reason: args?.failed ? (args?.reason ?? "memory retrieval failed") : null,
            })
            return { content: JSON.stringify(result) }
          }

          return { content: JSON.stringify(readinessFor(discovery, sessionId), null, 2) }
        },
      })

      editor.add({
        name: "gentjin_search",
        description:
          "Search the resolved project's Knowledge Vault for Markdown notes matching a query. " +
          "Returns ranked results (path, score, excerpt, metadata) using local lexical (BM25) ranking. " +
          "Read-only: it never modifies notes. Use it to find relevant prior knowledge before " +
          "reading full notes. Returns an empty result set (not an error) when nothing matches.",
        input: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search query text" },
            limit: { type: "number", description: "Maximum results to return (default 10, max 50)" },
            vault_root: { type: "string", description: "Optional override for the Knowledge Vault root; defaults to the resolved project vault" },
          },
          required: ["query"],
          additionalProperties: false,
        },
        async execute(args: PluginInput) {
          const a = args as PluginInput & { query?: string; limit?: number; vault_root?: string }
          const allowedRoots = [resolution.knowledge_root, join(homedir(), "Documents", "KnowledgeVault")]
          const vaultRoot = a?.vault_root ?? resolution.knowledge_root
          if (!isAuthorizedVaultRoot(vaultRoot, allowedRoots)) {
            return { content: JSON.stringify({ results: [], total: 0, query_terms: [], reason: "unauthorized vault root" }, null, 2) }
          }
          const result = searchNotes(vaultRoot, a?.query ?? "", { limit: a?.limit, allowedRoots })
          return { content: JSON.stringify(result, null, 2) }
        },
      })
    })

    await ctx.tool.hook("execute.after", async (event: ToolHookEvent) => {
      const sessionId = sessionFor(event?.sessionID)
      const args = (event?.input ?? {}) as ToolInput
      if (event?.tool === "read" && args.filePath && event.status === "error") {
        noteReadFailure(discovery, sessionId, args.filePath)
      }
    })

    await ctx.tool.hook("execute.before", async (event: ToolHookEvent) => {
      const sessionId = sessionFor(event?.sessionID)
      activeSession = sessionId
      const tool = event?.tool
      const args = (event?.input ?? {}) as ToolInput
      const filePath = args.filePath

      const orchestratorBlock = evaluateOrchestratorGuard({
        agent: event?.agent,
        tool,
        input: event?.input,
      })
      if (orchestratorBlock) throw new Error(orchestratorBlock)

      if (tool === "read" && filePath) {
        noteRead(discovery, sessionId, filePath)
        return
      }

      if (filePath && (tool === "grep" || tool === "glob" || tool === "list")) {
        return
      }

      if (tool !== undefined && SHELL_TOOLS.has(tool)) {
        const command = args.command
        if (typeof command !== "string") return

        const verdict: GuardVerdict = loader.checkCommand(command)
        if (!verdict.guarded) return

        const unloaded = (verdict.owners ?? []).filter((owner) => !loader.isLoaded(owner.capability.id))
        if (unloaded.length === 0) return

        tracer.record({
          tool,
          projectRoot: recordFor(discovery, sessionId)?.project_root ?? resolution.project_root,
          allowed: false,
          status: "workflow_guard",
          reasons: unloaded.map((owner) => `${owner.capability.id} not loaded`),
          sessionId,
        })

        const names = unloaded.map((owner) => `"${owner.capability.id}"`).join(" or ")
        const possessive = unloaded.length === 1 ? "its" : "their"

        throw new Error(
          [
            `Blocked: ${names} owns this action and ${possessive} instructions were not loaded in this session.`,
            `Call the overgeared_skills_capability tool with that id first, then follow those instructions.`,
            "Do not substitute a remembered procedure, a summary, or a custom script for the canonical workflow.",
          ].join("\n"),
        )
      }

      const gate = evaluateGate({ state: discovery, sessionId, tool: tool ?? "", filePath })
      // Record a structured advisory miss whenever an operation proceeds without complete discovery
      // readiness. Readiness stays advisory (never refused) here; the trace keeps the miss visible
      // and auditable instead of blocking the agent outright.
      if (gate.status && gate.status !== "ready") {
        tracer.record({
          tool: tool ?? "",
          filePath,
          projectRoot: recordFor(discovery, sessionId)?.project_root ?? resolution.project_root,
          allowed: gate.allowed !== false,
          status: gate.status ?? null,
          reasons: [gate.reason?.slice(0, 160) ?? "discovery readiness incomplete"],
          missing: Array.isArray(gate.missing) ? gate.missing : [],
          sessionId,
        })
      }
    })

    const controller = new AbortController()
    void (async () => {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        if (event?.type !== "session.idle") continue
        const report = loader.completionReport()
        if (report.findings.length > 0) {
          try {
            appendFileSync(join(tmpdir(), "overgeared-skills-adherence.log"), `${JSON.stringify(report)}\n`)
          } catch {
            // A session-end finding must never break the session.
          }
        }
        try {
          const eventSessionId =
            (event as { properties?: { sessionID?: string; sessionId?: string } })?.properties?.sessionID ??
            (event as { properties?: { sessionID?: string; sessionId?: string } })?.properties?.sessionId ??
            activeSession
          const summary = summarizeAdvisoryMisses(readGateTrace(), { sessionId: eventSessionId ?? undefined })
          if (summary.advisory_misses > 0) {
            appendFileSync(
              join(tmpdir(), "overgeared-skills-adherence.log"),
              `${JSON.stringify({ kind: "advisory_miss_summary", session: eventSessionId ?? null, ...summary, checked_at: new Date().toISOString() })}\n`,
            )
          }
        } catch {
          // A session-end summary must never break the session.
        }
      }
    })()

    return () => controller.abort()
  },
}