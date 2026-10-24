import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync } from "node:fs"
import { tmpdir, homedir } from "node:os"
import { join } from "node:path"
import { resolveProject, normalizeIdentifier, isWithin, expandHome } from "../src/discovery/resolve.mjs"
import {
  createDiscoveryState,
  beginSession,
  startDiscovery,
  declareScope,
  noteRead,
  noteReadFailure,
  recordMemory,
  readinessFor,
  evaluateGate,
} from "../src/discovery/gate.mjs"
import { READINESS } from "../src/discovery/readiness.mjs"

function fixture(options = {}) {
  const base = mkdtempSync(join(tmpdir(), "gentjin-disc-"))
  const root = join(base, "Cool_Project")
  mkdirSync(join(root, "src"), { recursive: true })
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: options.name ?? "My Cool_App" }))
  writeFileSync(join(root, "src", "app.js"), "module.exports = 1\n")
  if (options.git) mkdirSync(join(root, ".git"), { recursive: true })
  return { base, root }
}

test("identity follows the documented precedence and normalization", () => {
  const { base, root } = fixture({ name: "My Cool_App", git: true })
  try {
    const r = resolveProject(root)
    assert.equal(r.project_root, root)
    assert.equal(r.root_source, "git_root")
    assert.equal(r.identity, "My Cool_App")
    assert.equal(r.identity_source, "package.json.name")
    assert.equal(r.identifier, "my-cool-app")
    assert.equal(r.knowledge_root, join(homedir(), "Documents", "KnowledgeVault", "my-cool-app"))
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test("a non-git project still resolves, using the working directory", () => {
  const { base, root } = fixture({ name: "standalone" })
  try {
    const r = resolveProject(root)
    assert.equal(r.git, false)
    assert.equal(r.project_root, root)
    assert.equal(r.identifier, "standalone")
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test("an override file wins over the folder name and can redirect the knowledge root", () => {
  const { base, root } = fixture({ name: "ignored-name" })
  try {
    writeFileSync(
      join(root, ".project-agent.md"),
      ["---", "name: Real Project", "knowledge_root: ~/Documents/OtherVault", "---", ""].join("\n"),
    )
    const r = resolveProject(root)
    assert.equal(r.identity, "Real Project")
    assert.equal(r.identifier, "real-project")
    assert.equal(r.knowledge_root_source, "override")
    assert.equal(r.knowledge_root, join(homedir(), "Documents", "OtherVault"))
    assert.notEqual(r.identifier, normalizeIdentifier("ignored-name"))
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test("identifier normalization collapses separators and strips unsafe characters", () => {
  assert.equal(normalizeIdentifier("  My  Cool_Project!! "), "my-cool-project")
  assert.equal(normalizeIdentifier("A---B"), "a-b")
  assert.equal(normalizeIdentifier("!!!"), "")
})

test("isWithin does not treat a sibling with a shared prefix as inside", () => {
  const { base, root } = fixture()
  try {
    assert.equal(isWithin(join(root, "src", "a.js"), root), true)
    assert.equal(isWithin(join(root + "-other", "src", "a.js"), root), false)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

function readySession(sessionId = "s1", options = {}) {
  const { base, root } = fixture({ git: true })
  const state = createDiscoveryState()
  const resolution = { ...resolveProject(root), knowledge_root: join(base, "vault") }
  beginSession(state, sessionId, resolution)
  startDiscovery(state, sessionId)
  const target = join(root, "src", "app.js")
  if (options.read !== false) noteRead(state, sessionId, target)
  if (options.scope !== false) declareScope(state, sessionId, [target])
  if (options.memory !== false) {
    const searchTarget = join(resolution.knowledge_root, "memory-index.md")
    noteRead(state, sessionId, searchTarget)
    recordMemory(state, sessionId, {
      status: "ok",
      notes_read: [],
      no_relevant_notes: true,
      searched: ["memory-index.md"],
    })
  }
  return { base, root, state, sessionId, target }
}

test("an edit before discovery states what is missing without refusing it", () => {
  // Readiness is stated, not enforced. A hard block stranded agents that had nowhere to retrieve
  // from, and a gate that always refuses gets disabled rather than satisfied.
  const { base, root, state, sessionId } = readySession("s1", { read: false, scope: false, memory: false })
  try {
    const gate = evaluateGate({
      state,
      sessionId,
      tool: "write",
      filePath: join(root, "src", "new.js"),
    })
    assert.equal(gate.allowed, true)
    assert.equal(gate.advisory, true)
    assert.equal(gate.status, READINESS.IN_PROGRESS)
    assert.match(gate.reason, /gentjin_discovery/)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test("a satisfied gate is not marked advisory", () => {
  const { base, root, state, sessionId } = readySession("s2", { read: true, scope: true, memory: true })
  try {
    const gate = evaluateGate({
      state,
      sessionId,
      tool: "write",
      filePath: join(root, "src", "app.js"),
    })
    assert.equal(gate.allowed, true)
    assert.notEqual(gate.advisory, true)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test("a never-started session reports not_started rather than in_progress", () => {
  const { base, root } = fixture({ git: true })
  try {
    const state = createDiscoveryState()
    beginSession(state, "fresh", resolveProject(root))
    assert.equal(readinessFor(state, "fresh").status, READINESS.NOT_STARTED)

    const gate = evaluateGate({ state, sessionId: "fresh", tool: "edit", filePath: join(root, "src", "app.js") })
    assert.equal(gate.allowed, false)
    assert.equal(gate.status, READINESS.NOT_STARTED)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test("reading alone never satisfies readiness", () => {
  const { base, root, state, sessionId, target } = readySession("s1", { scope: false, memory: false })
  try {
    noteRead(state, sessionId, target)
    const verdict = readinessFor(state, sessionId)
    assert.notEqual(verdict.status, READINESS.READY)
    assert.match(verdict.reasons.join(" "), /intended path/)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test("declaring scope without a recorded read states the missing read", () => {
  const { base, root, state, sessionId } = readySession("s1", { read: false })
  try {
    const gate = evaluateGate({ state, sessionId, tool: "write", filePath: targetOf(state, sessionId) })
    assert.equal(gate.allowed, true)
    assert.equal(gate.advisory, true)
    assert.match(gate.reason, /no recorded read/)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

function targetOf(state, sessionId) {
  return startDiscovery(state, sessionId) && state.sessions.get(sessionId).intended_paths[0]
}

test("missing memory retrieval keeps readiness incomplete but is not an invented failure", () => {
  const { base, state, sessionId } = readySession("s1", { memory: false })
  try {
    const verdict = readinessFor(state, sessionId)
    assert.notEqual(verdict.status, READINESS.READY)
    assert.match(verdict.reasons.join(" "), /memory retrieval/)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test("no relevant notes is a valid retrieval result", () => {
  const { base, state, sessionId } = readySession("s1")
  try {
    assert.equal(readinessFor(state, sessionId).status, READINESS.READY)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test("genuine discovery permits the edit", () => {
  const { base, state, sessionId, target } = readySession("s1")
  try {
    assert.equal(readinessFor(state, sessionId).status, READINESS.READY)
    const gate = evaluateGate({ state, sessionId, tool: "edit", filePath: target })
    assert.equal(gate.allowed, true)
    assert.equal(gate.status, READINESS.READY)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test("read-only tools are never blocked, so recovery stays possible", () => {
  const { base, root, state, sessionId } = readySession("s1", { read: false, scope: false, memory: false })
  try {
    for (const tool of ["read", "grep", "glob", "list", "todowrite", "websearch"]) {
      const gate = evaluateGate({ state, sessionId, tool, filePath: join(root, "src", "app.js") })
      assert.equal(gate.allowed, true, tool)
    }
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test("writes inside the resolved knowledge root are allowed, outside it are not exempt", () => {
  const { base, state, sessionId } = readySession("s1", { read: false, scope: false, memory: false })
  try {
    const record = startDiscovery(state, sessionId)
    const inside = join(record.knowledge_root, "project", "overview.md")
    assert.equal(evaluateGate({ state, sessionId, tool: "write", filePath: inside }).allowed, true)

    const sibling = join(record.knowledge_root, "..", "SomeOtherVault", "notes.md")
    const gate = evaluateGate({ state, sessionId, tool: "write", filePath: sibling })
    assert.equal(gate.allowed, true)
    assert.match(gate.reason, /outside the resolved project root/)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test("one session's discovery cannot authorize another session's edit", () => {
  const { base, root, state } = readySession("session-a")
  try {
    const other = "session-b"
    const target = join(root, "src", "app.js")
    const gate = evaluateGate({ state, sessionId: other, tool: "edit", filePath: target })
    assert.equal(gate.allowed, false)
    assert.equal(gate.status, READINESS.NOT_STARTED)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test("a path outside the resolved project root is not governed by discovery readiness", () => {
  const { base, root, state, sessionId } = readySession("s1")
  try {
    const gate = evaluateGate({
      state,
      sessionId,
      tool: "edit",
      filePath: join(tmpdir(), "unrelated", "file.js"),
    })
    assert.equal(gate.allowed, true)
    assert.match(gate.reason, /outside the resolved project root/)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test("an explicit blocker on the record blocks readiness", () => {
  const { base, state, sessionId } = readySession("s1")
  try {
    const record = startDiscovery(state, sessionId)
    record.blockers = ["identity is ambiguous between two packages"]
    const verdict = readinessFor(state, sessionId)
    assert.equal(verdict.status, READINESS.BLOCKED)
    assert.match(verdict.reasons.join(" "), /ambiguous/)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test("a failed memory retrieval degrades rather than blocking", () => {
  const { base, state, sessionId } = readySession("s1", { memory: false })
  try {
    recordMemory(state, sessionId, { status: "error", reason: "vault unreadable", notes_read: [] })
    const verdict = readinessFor(state, sessionId)
    assert.equal(verdict.status, READINESS.DEGRADED)
    assert.match(verdict.reasons.join(" "), /vault unreadable/)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test("expanding the task to an uninspected area refreshes readiness", () => {
  const { base, root, state, sessionId } = readySession("s1")
  try {
    assert.equal(readinessFor(state, sessionId).status, READINESS.READY)

    const other = join(root, "src", "other.js")
    writeFileSync(other, "module.exports = 2\n")

    const gate = evaluateGate({ state, sessionId, tool: "write", filePath: other })
    assert.equal(gate.allowed, true, "a new file in an already inspected directory is in scope")

    const elsewhere = join(root, "lib", "deep.js")
    mkdirSync(join(root, "lib"), { recursive: true })
    writeFileSync(elsewhere, "module.exports = 3\n")
    declareScope(state, sessionId, [elsewhere])
    assert.notEqual(readinessFor(state, sessionId).status, READINESS.READY)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test("a monorepo is detected rather than assumed to be a single package", () => {
  const { base, root } = fixture({ name: "mono" })
  try {
    assert.equal(resolveProject(root).monorepo, false)
    mkdirSync(join(root, "packages", "core"), { recursive: true })
    writeFileSync(join(root, "packages", "core", "package.json"), JSON.stringify({ name: "core" }))
    assert.equal(resolveProject(root).monorepo, true)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test("a workspaces declaration is treated as a monorepo", () => {
  const { base, root } = fixture()
  try {
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "w", workspaces: ["packages/*"] }))
    assert.equal(resolveProject(root).monorepo, true)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test("expandHome resolves a leading tilde and leaves absolute paths alone", () => {
  assert.equal(expandHome("~/Documents/Vault"), join(homedir(), "Documents", "Vault"))
  const absolute = join(homedir(), "x")
  assert.equal(expandHome(absolute), absolute)
})

test("discovery never writes to the vault or the project while resolving", () => {
  const { base, root } = fixture({ git: true })
  try {
    const before = JSON.stringify(resolveProject(root))
    resolveProject(root)
    assert.equal(JSON.stringify(resolveProject(root)), before)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})
test("readiness is invalidated when an inspected file changes", () => {
  const { base, root, state, sessionId, target } = readySession("s1")
  try {
    assert.equal(readinessFor(state, sessionId).status, READINESS.READY)
    writeFileSync(target, "module.exports = 999\n")

    const after = readinessFor(state, sessionId)
    assert.notEqual(after.status, READINESS.READY)
    assert.match(after.reasons.join(" "), /intended path/)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test("readiness is invalidated when an inspected file is deleted", () => {
  const { base, state, sessionId, target } = readySession("s1")
  try {
    assert.equal(readinessFor(state, sessionId).status, READINESS.READY)
    rmSync(target)
    assert.notEqual(readinessFor(state, sessionId).status, READINESS.READY)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test("metadata-only revision movement does not invalidate readiness", () => {
  const { base, root, state, sessionId, target } = readySession("s1")
  try {
    mkdirSync(join(root, ".git", "refs", "heads"), { recursive: true })
    writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n")
    writeFileSync(join(root, ".git", "refs", "heads", "main"), `${"a".repeat(40)}\n`)
    writeFileSync(target, "module.exports = 5\n")
    noteRead(state, sessionId, target)
    declareScope(state, sessionId, [target])
    noteRead(state, sessionId, join(resolveProject(root).knowledge_root, "memory-index.md"))
    recordMemory(state, sessionId, { status: "ok", notes_read: [], no_relevant_notes: true, searched: ["memory-index.md"] })
    assert.equal(readinessFor(state, sessionId).status, READINESS.READY)

    // Only the commit ref moves; the inspected file content is unchanged, so readiness holds.
    writeFileSync(join(root, ".git", "refs", "heads", "main"), `${"b".repeat(40)}\n`)
    assert.equal(readinessFor(state, sessionId).status, READINESS.READY)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test("a content change after metadata movement still invalidates readiness", () => {
  const { base, root, state, sessionId, target } = readySession("s1")
  try {
    mkdirSync(join(root, ".git", "refs", "heads"), { recursive: true })
    writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n")
    writeFileSync(join(root, ".git", "refs", "heads", "main"), `${"a".repeat(40)}\n`)
    writeFileSync(target, "module.exports = 5\n")
    noteRead(state, sessionId, target)
    declareScope(state, sessionId, [target])
    noteRead(state, sessionId, join(resolveProject(root).knowledge_root, "memory-index.md"))
    recordMemory(state, sessionId, { status: "ok", notes_read: [], no_relevant_notes: true, searched: ["memory-index.md"] })
    assert.equal(readinessFor(state, sessionId).status, READINESS.READY)

    writeFileSync(join(root, ".git", "refs", "heads", "main"), `${"b".repeat(40)}\n`)
    writeFileSync(target, "module.exports = 999\n")
    assert.notEqual(readinessFor(state, sessionId).status, READINESS.READY)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test("an unchanged context keeps the previous verdict across repeated checks", () => {
  const { base, state, sessionId } = readySession("s1")
  try {
    assert.equal(readinessFor(state, sessionId).status, READINESS.READY)
    assert.equal(readinessFor(state, sessionId).status, READINESS.READY)
    assert.equal(readinessFor(state, sessionId).status, READINESS.READY)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test("a claimed note that was never read or does not exist is rejected", () => {
  const { base, root, state, sessionId } = readySession("s1")
  try {
    recordMemory(state, sessionId, {
      status: "ok",
      notes_read: [join(root, "nonexistent", "note.md")],
      no_relevant_notes: false,
    })
    const verdict = readinessFor(state, sessionId)
    assert.notEqual(verdict.status, READINESS.READY)
    assert.match(verdict.reasons.join(" "), /not verifiable/)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test("a note read this session inside the knowledge root is accepted", () => {
  const { base, state, sessionId } = readySession("s1")
  try {
    const vaultNote = join(state.sessions.get(sessionId).record.knowledge_root, "project", "overview.md")
    mkdirSync(join(vaultNote, ".."), { recursive: true })
    writeFileSync(vaultNote, "# overview\n")
    noteRead(state, sessionId, vaultNote)
    recordMemory(state, sessionId, { status: "ok", notes_read: [vaultNote], no_relevant_notes: false })

    assert.equal(readinessFor(state, sessionId).status, READINESS.READY)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test("a note path outside the resolved knowledge root is refused", () => {
  const { base, state, sessionId } = readySession("s1")
  try {
    const outside = join(base, "not-the-vault.md")
    writeFileSync(outside, "x\n")
    noteRead(state, sessionId, outside)
    recordMemory(state, sessionId, { status: "ok", notes_read: [outside], no_relevant_notes: false })

    const verdict = readinessFor(state, sessionId)
    assert.notEqual(verdict.status, READINESS.READY)
    assert.match(verdict.reasons.join(" "), /outside the resolved knowledge root/)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test("two sessions sharing one state never cross-authorize", () => {
  const { base, root } = fixture({ git: true })
  try {
    const state = createDiscoveryState()
    const resolution = resolveProject(root)
    const target = join(root, "src", "app.js")

    beginSession(state, "alpha", resolution)
    startDiscovery(state, "alpha")
    noteRead(state, "alpha", target)
    declareScope(state, "alpha", [target])
    const alphaSearch = join(resolution.knowledge_root, "memory-index.md")
    noteRead(state, "alpha", alphaSearch)
    recordMemory(state, "alpha", { status: "ok", notes_read: [], no_relevant_notes: true, searched: ["memory-index.md"] })
    assert.equal(readinessFor(state, "alpha").status, READINESS.READY)

    beginSession(state, "beta", resolution)
    assert.equal(readinessFor(state, "beta").status, READINESS.NOT_STARTED)
    assert.equal(evaluateGate({ state, sessionId: "beta", tool: "edit", filePath: target }).allowed, false)
    assert.equal(readinessFor(state, "alpha").status, READINESS.READY)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test("two separate states cannot see each other's discovery", () => {
  const { base, root } = fixture({ git: true })
  try {
    const a = createDiscoveryState()
    const b = createDiscoveryState()
    const resolution = resolveProject(root)
    const target = join(root, "src", "app.js")

    beginSession(a, "s", resolution)
    startDiscovery(a, "s")
    noteRead(a, "s", target)
    declareScope(a, "s", [target])
    noteRead(a, "s", join(resolution.knowledge_root, "memory-index.md"))
    recordMemory(a, "s", { status: "ok", notes_read: [], no_relevant_notes: true, searched: ["memory-index.md"] })

    assert.equal(evaluateGate({ state: a, sessionId: "s", tool: "edit", filePath: target }).allowed, true)
    assert.equal(evaluateGate({ state: b, sessionId: "s", tool: "edit", filePath: target }).allowed, false)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test("a read that failed is withdrawn and no longer counts as inspected context", () => {
  const { base, root, state, sessionId, target } = readySession("s1")
  try {
    assert.equal(readinessFor(state, sessionId).status, READINESS.READY)

    noteReadFailure(state, sessionId, target)
    const after = readinessFor(state, sessionId)
    assert.notEqual(after.status, READINESS.READY)
    assert.match(after.reasons.join(" "), /no recorded read/)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test("withdrawing an unrelated failed read does not disturb a valid session", () => {
  const { base, state, sessionId } = readySession("s1")
  try {
    noteReadFailure(state, sessionId, join(tmpdir(), "never-existed.txt"))
    assert.equal(readinessFor(state, sessionId).status, READINESS.READY)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})
