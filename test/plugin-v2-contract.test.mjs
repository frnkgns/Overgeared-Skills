import test from "node:test"
import assert from "node:assert/strict"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..")
const target = join(repoRoot, "package.json")

/**
 * Drives the plugin through a v2-shaped context and captures what it registers, so the
 * hook contract can be exercised without a running OpenCode server.
 */
async function mount(sessionID) {
  const module = await import("../plugins/overgeared-skills-capabilities.ts")
  const hooks = new Map()
  const sessionHooks = new Map()
  const tools = new Map()

  const ctx = {
    sessionID,
    location: { directory: repoRoot, project: { id: "gentjin" } },
    tool: {
      transform: async (callback) => {
        callback({ add: (definition) => tools.set(definition.name, definition) })
      },
      hook: async (name, callback) => {
        hooks.set(name, callback)
      },
    },
    session: {
      hook: async (name, callback) => {
        sessionHooks.set(name, callback)
      },
    },
    event: {
      subscribe: () => ({
        // Never yields, so the plugin's session.idle check cannot interfere.
        async *[Symbol.asyncIterator]() {},
      }),
    },
  }

  const cleanup = await module.default.setup(ctx)
  const call = (name, input) => tools.get(name).execute(input).then((r) => JSON.parse(r.content))

  // Resolve identity and declare the file as in scope, so readiness reports whether an
  // inspected source area covers it. That coverage gap is the only public signal that a
  // read was recorded, and it is the signal the gate itself acts on.
  await call("gentjin_discovery", { action: "resolve" })
  await call("gentjin_discovery", { action: "scope", paths: [target] })

  return {
    tools,
    sessionHooks,
    before: (event) => hooks.get("execute.before")(event),
    after: (event) => hooks.get("execute.after")(event),
    status: () => call("gentjin_discovery", { action: "status" }),
    /**
     * True while readiness still reports that no recorded read touched the target.
     * Declaring a scope satisfies source-area coverage on its own, so this specific
     * reason is what proves a read actually reached the discovery state.
     */
    unread: async () =>
      (await call("gentjin_discovery", { action: "status" })).reasons.some((reason) =>
        reason.includes(`no recorded read in this session touched ${target}`),
      ),
    cleanup,
  }
}

test("the v2 tool hook reads its arguments from event.input", async () => {
  const plugin = await mount("v2-input")

  assert.equal(await plugin.unread(), true, "the target must start out uncovered")

  await plugin.before({ tool: "read", input: { filePath: target } })

  assert.equal(
    await plugin.unread(),
    false,
    "a v2 event.input argument must be recorded as a read of the target",
  )

  plugin.cleanup()
})

test("the retired v1 event.args shape no longer feeds the discovery gate", async () => {
  // v1 passed separate input and output objects, and the port briefly read `args`. Silently
  // accepting it would let a half-migrated plugin look healthy while recording no reads,
  // which is exactly how an unrecorded gate fails without anyone noticing.
  const plugin = await mount("v1-args")

  await plugin.before({ tool: "read", args: { filePath: target } })

  assert.equal(
    await plugin.unread(),
    true,
    "the v1 args shape must not be read as event.input",
  )

  plugin.cleanup()
})

test("a failed read is dropped from the recorded reads", async () => {
  const plugin = await mount("v2-after")

  await plugin.before({ tool: "read", input: { filePath: target } })
  assert.equal(await plugin.unread(), false, "the read must register first")

  await plugin.after({ tool: "read", status: "error", input: { filePath: target } })

  assert.equal(await plugin.unread(), true, "a failed read must not count as read")

  plugin.cleanup()
})

test("a successful read survives the after hook", async () => {
  const plugin = await mount("v2-after-ok")

  await plugin.before({ tool: "read", input: { filePath: target } })
  await plugin.after({ tool: "read", status: "completed", input: { filePath: target }, result: {} })

  assert.equal(await plugin.unread(), false, "a completed read must stay recorded")

  plugin.cleanup()
})

test("a bash argument is read from event.input for the workflow guard", async () => {
  const plugin = await mount("v2-bash")

  // A guarded command whose capability was never loaded must be refused. The guard reads
  // the command from event.input; under the v1 shape it saw nothing and passed silently.
  await assert.rejects(
    () => plugin.before({ tool: "bash", input: { command: "node sync.mjs ~/.config/opencode" } }),
    /not loaded|were not loaded/i,
    "a governed mutation must be refused until its capability body is loaded",
  )

  plugin.cleanup()
})

test("an ordinary command is not refused by the workflow guard", async () => {
  const plugin = await mount("v2-bash-ordinary")

  await plugin.before({ tool: "bash", input: { command: "git status" } })

  plugin.cleanup()
})

test("the plugin never mutates a user prompt", async () => {
  // Vault content must never be appended to what the user typed. Looking memory up is the
  // model's job, driven by the instruction files, not something the runtime does behind the
  // user's back. Registering any session hook here is how that came back once already.
  const plugin = await mount("v2-no-prompt-mutation")

  assert.deepEqual([...plugin.sessionHooks.keys()], [], "the plugin must register no session hook")

  plugin.cleanup()
})

test("the plugin registers all four tools on a v2 context", async () => {
  const plugin = await mount("v2-tools")

  assert.deepEqual(
    [...plugin.tools.keys()].sort(),
    ["gentjin_discovery", "gentjin_release_notes", "gentjin_search", "overgeared_skills_capability"],
  )

  for (const tool of plugin.tools.values()) {
    assert.equal(tool.input.type, "object", `${tool.name} needs a JSON Schema input`)
    assert.ok(Array.isArray(tool.input.required), `${tool.name} needs a required list`)
  }

  plugin.cleanup()
})

test("every registered tool returns structured content", async () => {
  const plugin = await mount("v2-content")

  const result = await plugin.tools.get("overgeared_skills_capability").execute({ id: "does-not-exist" })
  assert.equal(typeof result.content, "string")
  assert.match(result.content, /CAPABILITY_UNAVAILABLE/)

  plugin.cleanup()
})