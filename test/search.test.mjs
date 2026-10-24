import test from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { searchNotes } from "../src/memory/search.mjs"
import { listNotes } from "../src/memory/vault.mjs"

function vault() {
  const base = mkdtempSync(join(tmpdir(), "gentjin-search-"))
  const root = join(base, "vault")
  mkdirSync(root, { recursive: true })
  return { base, root }
}

function writeNote(root, rel, content) {
  const full = join(root, rel)
  mkdirSync(join(full, ".."), { recursive: true })
  writeFileSync(full, content)
  return full
}

test("relevant notes rank above unrelated notes", () => {
  const { base, root } = vault()
  try {
    writeNote(root, "a.md", "---\ntitle: Caching strategy\n---\n\nWe use a cache to speed up database reads.\n")
    writeNote(root, "b.md", "---\ntitle: Deployment guide\n---\n\nSteps to deploy the service to production.\n")
    const res = searchNotes(root, "cache database")
    assert.ok(res.results.length >= 1)
    assert.equal(res.results[0].path, "a.md")
    assert.ok(res.results[0].score > 0)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test("title and metadata matches are handled", () => {
  const { base, root } = vault()
  try {
    writeNote(root, "x.md", "---\ntitle: Authentication flow\ntags: auth security\n---\n\nLogin and token handling.\n")
    writeNote(root, "y.md", "---\ntitle: Logging setup\n---\n\nConfigure log levels.\n")
    const res = searchNotes(root, "authentication")
    assert.equal(res.results.length, 1)
    assert.equal(res.results[0].path, "x.md")
    assert.equal(res.results[0].metadata.tags, "auth security")
    assert.match(res.results[0].excerpt, /login|token|auth/i)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test("empty query returns no results with a reason", () => {
  const { base, root } = vault()
  try {
    writeNote(root, "a.md", "# A\n\nContent.\n")
    const res = searchNotes(root, "   ")
    assert.equal(res.results.length, 0)
    assert.equal(res.reason, "empty query")
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test("missing vault returns a safe result", () => {
  const base = mkdtempSync(join(tmpdir(), "gentjin-search-"))
  try {
    const res = searchNotes(join(base, "nope"), "anything")
    assert.equal(res.results.length, 0)
    assert.equal(res.reason, "vault not found")
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test("no-match returns empty results without an error reason", () => {
  const { base, root } = vault()
  try {
    writeNote(root, "a.md", "# A\n\nContent about apples.\n")
    const res = searchNotes(root, "zzzznonexistent")
    assert.equal(res.results.length, 0)
    assert.equal(res.total, 0)
    assert.ok(!res.reason || res.reason !== "vault not found")
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test("oversized and binary files are skipped", () => {
  const { base, root } = vault()
  try {
    const big = "a ".repeat(600 * 1024)
    writeNote(root, "big.md", big)
    writeFileSync(join(root, "bin.md"), "hello\0world")
    writeNote(root, "small.md", "# small\n\nneedle content here.\n")
    const res = searchNotes(root, "needle")
    assert.equal(res.results.length, 1)
    assert.equal(res.results[0].path, "small.md")
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test("ignored directories are not traversed", () => {
  const { base, root } = vault()
  try {
    mkdirSync(join(root, ".git"), { recursive: true })
    writeFileSync(join(root, ".git", "secret.md"), "# secret\n\nhidden needle\n")
    mkdirSync(join(root, "node_modules"), { recursive: true })
    writeFileSync(join(root, "node_modules", "x.md"), "# x\n\nhidden needle\n")
    writeNote(root, "ok.md", "# ok\n\nvisible needle\n")
    const res = searchNotes(root, "needle")
    assert.equal(res.results.length, 1)
    assert.equal(res.results[0].path, "ok.md")
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test("path traversal via .. is contained to the vault", () => {
  const { base, root } = vault()
  try {
    writeNote(root, "a.md", "# A\n\ncontent\n")
    // searchNotes resolves vaultRoot; a relative traversal query should not escape.
    const res = searchNotes(root, "../etc/passwd")
    // Should not throw; results may be empty or match nothing dangerous.
    assert.ok(Array.isArray(res.results))
    for (const r of res.results) {
      assert.ok(!r.path.includes(".."))
    }
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test("symlink escape is not followed", () => {
  const { base, root } = vault()
  const outside = mkdtempSync(join(tmpdir(), "gentjin-outside-"))
  try {
    writeFileSync(join(outside, "secret.md"), "# secret\n\nescape needle\n")
    try {
      symlinkSync(join(outside, "secret.md"), join(root, "link.md"))
    } catch {
      // symlink creation may require privileges; skip assertion if unavailable
      return
    }
    writeNote(root, "real.md", "# real\n\nreal needle\n")
    const res = searchNotes(root, "needle")
    const paths = res.results.map((r) => r.path)
    assert.ok(paths.includes("real.md"))
    assert.ok(!paths.includes("link.md"))
  } finally {
    rmSync(base, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

test("results are deterministic across repeated calls", () => {
  const { base, root } = vault()
  try {
    writeNote(root, "a.md", "# Alpha\n\nshared term here.\n")
    writeNote(root, "b.md", "# Beta\n\nshared term there.\n")
    const r1 = searchNotes(root, "shared term")
    const r2 = searchNotes(root, "shared term")
    assert.deepEqual(r1.results.map((x) => x.path), r2.results.map((x) => x.path))
    assert.deepEqual(r1.results.map((x) => x.score), r2.results.map((x) => x.score))
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test("limit is respected", () => {
  const { base, root } = vault()
  try {
    for (let i = 0; i < 5; i++) writeNote(root, `n${i}.md`, `# N${i}\n\ncommon word\n`)
    const res = searchNotes(root, "common", { limit: 2 })
    assert.equal(res.results.length, 2)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test("malformed frontmatter does not break search", () => {
  const { base, root } = vault()
  try {
    writeFileSync(join(root, "bad.md"), "---\n: : :\n---\n\nbody needle\n")
    writeNote(root, "good.md", "# good\n\nneedle here\n")
    const res = searchNotes(root, "needle")
    assert.ok(res.results.length >= 1)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test("unauthorized vault root is rejected when allowedRoots is provided", () => {
  const { base, root } = vault()
  const other = mkdtempSync(join(tmpdir(), "gentjin-other-"))
  try {
    writeNote(root, "a.md", "# A\n\nneedle\n")
    const allowed = [join(base, "allowed-vault")]
    mkdirSync(join(base, "allowed-vault"), { recursive: true })
    const res = searchNotes(root, "needle", { allowedRoots: allowed })
    assert.equal(res.results.length, 0)
    assert.equal(res.reason, "unauthorized vault root")
  } finally {
    rmSync(base, { recursive: true, force: true })
    rmSync(other, { recursive: true, force: true })
  }
})

test("authorized vault root is accepted", () => {
  const { base, root } = vault()
  try {
    writeNote(root, "a.md", "# A\n\nneedle\n")
    const res = searchNotes(root, "needle", { allowedRoots: [base] })
    // root is under base, so authorized
    assert.equal(res.results.length, 1)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test("traversal path is rejected", () => {
  const { base, root } = vault()
  try {
    const allowed = [root]
    const traversal = join(root, "..", "..")
    const res = searchNotes(traversal, "needle", { allowedRoots: allowed })
    assert.equal(res.results.length, 0)
    assert.equal(res.reason, "unauthorized vault root")
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test("isAuthorizedVaultRoot rejects symlink escape", async () => {
  const { isAuthorizedVaultRoot } = await import("../src/memory/search.mjs")
  const base = mkdtempSync(join(tmpdir(), "gentjin-sym-"))
  const allowed = join(base, "allowed")
  const outside = join(base, "outside")
  try {
    mkdirSync(allowed, { recursive: true })
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(outside, "secret.md"), "x")
    let linkPath
    try {
      linkPath = join(allowed, "link")
      symlinkSync(outside, linkPath, "dir")
    } catch {
      return // skip if symlinks unavailable
    }
    const authorized = isAuthorizedVaultRoot(linkPath, [allowed])
    assert.equal(authorized, false)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test("missing session id does not attribute other sessions' misses", async () => {
  const { createGateTracer, readGateTrace, summarizeAdvisoryMisses } = await import("../src/discovery/gate-trace.mjs")
  const dir = mkdtempSync(join(tmpdir(), "gentjin-gt-"))
  const file = join(dir, "gate.jsonl")
  try {
    const tracer = createGateTracer({ file })
    tracer.record({ tool: "edit", filePath: "a.js", projectRoot: "/p", allowed: true, status: "in_progress", reasons: ["r"], sessionId: "session-other" })
    const entries = readGateTrace(file)
    const summary = summarizeAdvisoryMisses(entries) // no sessionId
    assert.equal(summary.advisory_misses, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("frontmatter-only match still returns the note", () => {
  const { base, root } = vault()
  try {
    writeNote(root, "meta.md", "---\ntitle: Zeta\nauthor: alice\n---\n\nUnrelated body content.\n")
    const res = searchNotes(root, "alice")
    assert.equal(res.results.length, 1)
    assert.equal(res.results[0].path, "meta.md")
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})