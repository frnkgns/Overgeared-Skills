import test from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createDiscoveryState,
  beginSession,
  startDiscovery,
  declareScope,
  noteRead,
  recordMemory,
  readinessFor,
  knowledgeRootHasNotes,
} from "../src/discovery/gate.mjs"
import { resolveProject } from "../src/discovery/resolve.mjs"

function project(name) {
  const base = mkdtempSync(join(tmpdir(), "gentjin-mem-"))
  const root = join(base, name)
  mkdirSync(join(root, "src"), { recursive: true })
  writeFileSync(join(root, "package.json"), JSON.stringify({ name }))
  writeFileSync(join(root, "src", "app.js"), "module.exports = 1\n")
  return { base, root }
}

function ready(name, sessionId = "s1") {
  const { base, root } = project(name)
  const resolution = { ...resolveProject(root), knowledge_root: join(base, "vault") }
  const state = createDiscoveryState()
  beginSession(state, sessionId, resolution)
  startDiscovery(state, sessionId)
  const target = join(root, "src", "app.js")
  noteRead(state, sessionId, target)
  declareScope(state, sessionId, [target])
  return { base, root, state, sessionId, target, vault: resolution.knowledge_root }
}

test("no_relevant_notes without a search scope is refused", () => {
  const ctx = ready("mem-scope-1")
  try {
    mkdirSync(ctx.vault, { recursive: true })
    recordMemory(ctx.state, ctx.sessionId, { status: "ok", notes_read: [], no_relevant_notes: true })
    const verdict = readinessFor(ctx.state, ctx.sessionId)
    assert.notEqual(verdict.status, "ready")
    assert.match(verdict.reasons.join(" "), /no search scope recorded/)
  } finally {
    rmSync(ctx.base, { recursive: true, force: true })
  }
})

test("no_relevant_notes with a scope that was never searched is refused", () => {
  const ctx = ready("mem-scope-2")
  try {
    mkdirSync(ctx.vault, { recursive: true })
    recordMemory(ctx.state, ctx.sessionId, {
      status: "ok",
      notes_read: [],
      no_relevant_notes: true,
      searched: ["project/"],
    })
    const verdict = readinessFor(ctx.state, ctx.sessionId)
    assert.notEqual(verdict.status, "ready")
    assert.match(verdict.reasons.join(" "), /not actually read or searched/)
  } finally {
    rmSync(ctx.base, { recursive: true, force: true })
  }
})

test("no_relevant_notes with an observed, scoped search is accepted", () => {
  const ctx = ready("mem-scope-3")
  try {
    const index = join(ctx.vault, "memory-index.md")
    noteRead(ctx.state, ctx.sessionId, index)
    recordMemory(ctx.state, ctx.sessionId, {
      status: "ok",
      notes_read: [],
      no_relevant_notes: true,
      searched: ["memory-index.md"],
    })
    assert.equal(readinessFor(ctx.state, ctx.sessionId).status, "ready")
  } finally {
    rmSync(ctx.base, { recursive: true, force: true })
  }
})

test("a scope outside the resolved knowledge root is refused", () => {
  const ctx = ready("mem-scope-4")
  try {
    mkdirSync(ctx.vault, { recursive: true })
    const outside = join(ctx.base, "other-vault", "memory-index.md")
    noteRead(ctx.state, ctx.sessionId, outside)
    recordMemory(ctx.state, ctx.sessionId, {
      status: "ok",
      notes_read: [],
      no_relevant_notes: true,
      searched: [outside],
    })
    const verdict = readinessFor(ctx.state, ctx.sessionId)
    assert.notEqual(verdict.status, "ready")
    assert.match(verdict.reasons.join(" "), /outside the resolved knowledge root/)
  } finally {
    rmSync(ctx.base, { recursive: true, force: true })
  }
})

test("claiming no notes while a real index exists still requires a scoped search", () => {
  const ctx = ready("mem-scope-5")
  try {
    const index = join(ctx.vault, "memory-index.md")
    mkdirSync(ctx.vault, { recursive: true })
    writeFileSync(index, "# index\n")
    recordMemory(ctx.state, ctx.sessionId, { status: "ok", notes_read: [], no_relevant_notes: true })
    const verdict = readinessFor(ctx.state, ctx.sessionId)
    assert.notEqual(verdict.status, "ready")
  } finally {
    rmSync(ctx.base, { recursive: true, force: true })
  }
})

test("an existing index plus an observed scoped search satisfies the claim", () => {
  const ctx = ready("mem-scope-6")
  try {
    const index = join(ctx.vault, "memory-index.md")
    mkdirSync(ctx.vault, { recursive: true })
    writeFileSync(index, "# index\n")
    noteRead(ctx.state, ctx.sessionId, index)
    recordMemory(ctx.state, ctx.sessionId, {
      status: "ok",
      notes_read: [],
      no_relevant_notes: true,
      searched: ["memory-index.md"],
    })
    assert.equal(readinessFor(ctx.state, ctx.sessionId).status, "ready")
  } finally {
    rmSync(ctx.base, { recursive: true, force: true })
  }
})

test("a project with no vault at all satisfies no_relevant_notes without an invented search", () => {
  const ctx = ready("mem-no-vault-project")
  try {
    assert.equal(existsSync(ctx.vault), false, "fixture must have no knowledge root")
    recordMemory(ctx.state, ctx.sessionId, { status: "ok", notes_read: [], no_relevant_notes: true })
    assert.equal(readinessFor(ctx.state, ctx.sessionId).status, "ready")
  } finally {
    rmSync(ctx.base, { recursive: true, force: true })
  }
})

test("an existing vault still requires a scoped, observed search", () => {
  const ctx = ready("mem-existing-vault-project")
  try {
    mkdirSync(ctx.vault, { recursive: true })
    writeFileSync(join(ctx.vault, "memory-index.md"), "# index\n")
    recordMemory(ctx.state, ctx.sessionId, { status: "ok", notes_read: [], no_relevant_notes: true })
    assert.notEqual(readinessFor(ctx.state, ctx.sessionId).status, "ready")
  } finally {
    rmSync(ctx.base, { recursive: true, force: true })
  }
})

test("knowledgeRootHasNotes recognizes a note without memory-index.md", () => {
  const base = mkdtempSync(join(tmpdir(), "gentjin-kh-"))
  try {
    const vault = join(base, "vault")
    mkdirSync(join(vault, "knowledge"), { recursive: true })
    writeFileSync(join(vault, "knowledge", "note.md"), "# A note\n\nSome content.\n")
    assert.equal(knowledgeRootHasNotes(vault), true)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test("knowledgeRootHasNotes returns false for an empty vault", () => {
  const base = mkdtempSync(join(tmpdir(), "gentjin-kh-"))
  try {
    const vault = join(base, "vault")
    mkdirSync(vault, { recursive: true })
    assert.equal(knowledgeRootHasNotes(vault), false)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test("a vault with a note but no index still requires a scoped search", () => {
  const ctx = ready("mem-note-no-index")
  try {
    mkdirSync(ctx.vault, { recursive: true })
    mkdirSync(join(ctx.vault, "knowledge"), { recursive: true })
    writeFileSync(join(ctx.vault, "knowledge", "note.md"), "# note\n")
    recordMemory(ctx.state, ctx.sessionId, { status: "ok", notes_read: [], no_relevant_notes: true })
    assert.notEqual(readinessFor(ctx.state, ctx.sessionId).status, "ready")
  } finally {
    rmSync(ctx.base, { recursive: true, force: true })
  }
})

test("knowledgeRootHasNotes returns false for a missing vault", () => {
  const base = mkdtempSync(join(tmpdir(), "gentjin-kh-"))
  try {
    assert.equal(knowledgeRootHasNotes(join(base, "does-not-exist")), false)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test("knowledgeRootHasNotes ignores non-markdown and ignored directories", () => {
  const base = mkdtempSync(join(tmpdir(), "gentjin-kh-"))
  try {
    const vault = join(base, "vault")
    mkdirSync(join(vault, ".git"), { recursive: true })
    mkdirSync(join(vault, "node_modules"), { recursive: true })
    writeFileSync(join(vault, ".git", "HEAD"), "ref")
    writeFileSync(join(vault, "node_modules", "x.md"), "# x")
    writeFileSync(join(vault, "binary.bin"), "data")
    assert.equal(knowledgeRootHasNotes(vault), false)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})
