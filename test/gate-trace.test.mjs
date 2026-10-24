import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createGateTracer, readGateTrace, summarizeAdvisoryMisses, summarizeGateTrace } from "../src/discovery/gate-trace.mjs"

test("a refusal is recorded with its reason and no absolute path", () => {
  const dir = mkdtempSync(join(tmpdir(), "gentjin-gt-"))
  const file = join(dir, "gate.jsonl")
  try {
    const tracer = createGateTracer({ file })
    const entry = tracer.record({
      tool: "edit",
      filePath: join(dir, "project", "src", "app.js"),
      projectRoot: join(dir, "project"),
      allowed: false,
      status: "in_progress",
      reasons: ["no recorded read in this session touched app.js"],
      sessionId: "session-secret-value",
    })

    assert.equal(entry.decision, "refused")
    assert.equal(entry.path, "src/app.js")
    assert.equal(entry.readiness, "in_progress")
    assert.notEqual(entry.session, "session-secret-value")
    assert.match(entry.session, /^[0-9a-f]{12}$/)

    const raw = readGateTrace(file)[0]
    assert.equal(raw.decision, "refused")
    assert.equal(raw.path, "src/app.js")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("an allowance is recorded too, so refusals are not the only visible outcome", () => {
  const dir = mkdtempSync(join(tmpdir(), "gentjin-gt-"))
  const file = join(dir, "gate.jsonl")
  try {
    const tracer = createGateTracer({ file })
    tracer.record({ tool: "write", filePath: join(dir, "project", "a.js"), projectRoot: join(dir, "project"), allowed: true, status: "ready" })
    assert.equal(readGateTrace(file)[0].decision, "allowed")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a disabled tracer writes nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "gentjin-gt-"))
  const file = join(dir, "gate.jsonl")
  try {
    const tracer = createGateTracer({ file })
    tracer.disable()
    assert.equal(tracer.record({ tool: "edit", filePath: "x", allowed: false }), null)
    assert.equal(readGateTrace(file).length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("an advisory miss records its missing prerequisites", () => {
  const dir = mkdtempSync(join(tmpdir(), "gentjin-gt-"))
  const file = join(dir, "gate.jsonl")
  try {
    const tracer = createGateTracer({ file })
    const entry = tracer.record({
      tool: "edit",
      filePath: join(dir, "project", "src", "app.js"),
      projectRoot: join(dir, "project"),
      allowed: true,
      status: "in_progress",
      reasons: ["no recorded read in this session touched app.js"],
      missing: ["no recorded read in this session touched app.js", "no memory retrieval result recorded"],
      sessionId: "s",
    })
    assert.deepEqual(entry.missing, ["no recorded read in this session touched app.js", "no memory retrieval result recorded"])
    assert.equal(readGateTrace(file)[0].missing.length, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("summarizeAdvisoryMisses aggregates misses and ignores ready/refused entries", () => {
  const entries = [
    { decision: "allowed", readiness: "in_progress", tool: "edit", missing: ["no recorded read"], session: null },
    { decision: "allowed", readiness: "not_started", tool: "write", missing: ["no memory retrieval result recorded"], session: null },
    { decision: "allowed", readiness: "ready", tool: "edit", missing: [], session: null },
    { decision: "refused", readiness: "in_progress", tool: "edit", missing: ["x"], session: null },
  ]
  const summary = summarizeAdvisoryMisses(entries)
  assert.equal(summary.advisory_misses, 2)
  assert.equal(summary.total_entries, 4)
  assert.equal(summary.by_tool.edit, 1)
  assert.equal(summary.by_tool.write, 1)
  assert.equal(summary.by_readiness.in_progress, 1)
  assert.equal(summary.by_readiness.not_started, 1)
  // Both misses are unattributed (session null), so no distinct sessions are counted.
  assert.equal(summary.sessions, 0)
  assert.equal(summarizeGateTrace(entries).advisory_misses, 2)
})

test("summarizeAdvisoryMisses scopes misses to the requested session", () => {
  const sessionA = "session-alpha"
  const sessionB = "session-beta"
  const entries = [
    { decision: "allowed", readiness: "in_progress", tool: "edit", missing: ["no read"], session: null },
  ]
  // Build entries with real anonymized session keys by using the tracer.
  const dir = mkdtempSync(join(tmpdir(), "gentjin-gt-"))
  const file = join(dir, "gate.jsonl")
  try {
    const tracer = createGateTracer({ file })
    tracer.record({ tool: "edit", filePath: "a.js", projectRoot: "/p", allowed: true, status: "in_progress", reasons: ["r"], sessionId: sessionA })
    tracer.record({ tool: "write", filePath: "b.js", projectRoot: "/p", allowed: true, status: "not_started", reasons: ["r2"], sessionId: sessionB })
    const all = readGateTrace(file)
    const forA = summarizeAdvisoryMisses(all, { sessionId: sessionA })
    const forB = summarizeAdvisoryMisses(all, { sessionId: sessionB })
    assert.equal(forA.advisory_misses, 1)
    assert.equal(forA.by_tool.edit, 1)
    assert.equal(forB.advisory_misses, 1)
    assert.equal(forB.by_tool.write, 1)
    const unscoped = summarizeAdvisoryMisses(all)
    // Unscoped calls never attribute another session's misses, so attributed entries are excluded.
    assert.equal(unscoped.advisory_misses, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("summarizeAdvisoryMisses handles an empty input", () => {
  const summary = summarizeAdvisoryMisses([])
  assert.equal(summary.advisory_misses, 0)
  assert.equal(summary.total_entries, 0)
  assert.deepEqual(summary.by_tool, {})
})

test("the trace never stores file content or command text", () => {
  const dir = mkdtempSync(join(tmpdir(), "gentjin-gt-"))
  const file = join(dir, "gate.jsonl")
  try {
    const tracer = createGateTracer({ file })
    const entry = tracer.record({
      tool: "write",
      filePath: join(dir, "project", "secret.txt"),
      projectRoot: join(dir, "project"),
      allowed: false,
      status: "in_progress",
      reasons: ["readiness incomplete"],
      sessionId: "s",
    })
    const serialized = JSON.stringify(entry)
    assert.equal(serialized.includes("secret"), true)
    assert.equal(serialized.includes("content"), false)
    assert.equal(serialized.includes("command"), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
