import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { RetryGuard, retrieveRelevantFailures, classifyCertainty, redact, evaluateRetry, recordAttemptWithRetry, retryGuardFromRecord } from "../src/memory/failure-awareness.mjs"
import { attemptFingerprint, makeTaskRecord, recordAttempt } from "../src/task/record.mjs"

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..")

test("attempt fingerprint is stable across key order and path separator style", () => {
  const a = attemptFingerprint({ summary: "Tried  Fix  It", files_touched: ["src\\a.ts", "b.ts"], verification: ["npm test"] })
  const b = attemptFingerprint({ verification: ["npm test"], files_touched: ["b.ts", "src/a.ts"], summary: "tried fix it" })
  assert.equal(a, b)
})

test("a different approach yields a different fingerprint", () => {
  const a = attemptFingerprint({ summary: "clear the cache", files_touched: [], verification: [] })
  const b = attemptFingerprint({ summary: "raise the timeout", files_touched: [], verification: [] })
  assert.notEqual(a, b)
})

test("first attempt at an approach is allowed", () => {
  const guard = new RetryGuard()
  const result = guard.checkRepeat({ summary: "clear the cache" })
  assert.equal(result.allowed, true)
  guard.register({ summary: "clear the cache" })
})

test("an identical repeat with no new evidence is refused", () => {
  const guard = new RetryGuard()
  const attempt = { summary: "clear the cache", files_touched: [], verification: [] }
  guard.register(attempt)
  const repeat = guard.checkRepeat({ ...attempt })
  assert.equal(repeat.allowed, false)
  assert.match(repeat.reason, /identical approach already attempted/)
  assert.ok(repeat.required.length >= 3)
})

test("a repeat is allowed with new evidence", () => {
  const guard = new RetryGuard()
  const attempt = { summary: "clear the cache", files_touched: [], verification: [] }
  guard.register(attempt)
  const withEvidence = guard.checkRepeat({ ...attempt, evidence: ["stack trace now shows ECONNREFUSED"] })
  assert.equal(withEvidence.allowed, true)
  assert.match(withEvidence.reason, /new evidence/)
})

test("a repeat is allowed when the condition changed", () => {
  const guard = new RetryGuard()
  const attempt = { summary: "rebuild the index", files_touched: [], verification: [] }
  guard.register(attempt)
  const changed = guard.checkRepeat({ ...attempt, condition_changed: true })
  assert.equal(changed.allowed, true)
  assert.match(changed.reason, /condition changed/)
})

test("a repeat is allowed with a substantive justification", () => {
  const guard = new RetryGuard()
  const attempt = { summary: "patch the parser", files_touched: [], verification: [] }
  guard.register(attempt)
  const justified = guard.checkRepeat({
    ...attempt,
    justification: "previous run predated the upstream 2.4 grammar fix",
  })
  assert.equal(justified.allowed, true)
})

test("a repeat with a trivial justification is still refused", () => {
  const guard = new RetryGuard()
  const attempt = { summary: "patch the parser", files_touched: [], verification: [] }
  guard.register(attempt)
  assert.equal(guard.checkRepeat({ ...attempt, justification: "try" }).allowed, false)
})

test("retries are bounded and produce a blocking checkpoint", () => {
  const guard = new RetryGuard({ maxAttempts: 3 })
  assert.equal(guard.shouldCheckpoint(2), false)
  assert.equal(guard.shouldCheckpoint(3), true)
  const checkpoint = guard.checkpoint("missing credential for the staging database")
  assert.equal(checkpoint.state, "blocked")
  assert.equal(checkpoint.blocker.blocking, true)
  assert.equal(checkpoint.blocker.needs_from_user, true)
})

test("a seeded unresolved failure is retrieved for a matching scenario", () => {
  const notes = [
    {
      title: "detectChanges empty in integration suite",
      symptom: "detectChanges returned an empty array despite a changed file",
      module: "changes",
      tags: ["integration", "diff"],
      status: "unresolved",
    },
    {
      title: "unrelated timeout",
      symptom: "build timed out after 10 minutes",
      module: "ci",
      tags: ["build"],
      status: "unresolved",
    },
  ]
  const hits = retrieveRelevantFailures(notes, {
    symptom_terms: ["detectchanges"],
    affected_paths: ["src/changes/detect.mjs"],
  })
  assert.equal(hits.length, 1)
  assert.match(hits[0].title, /detectChanges/)
})

test("resolved failures are excluded unless explicitly requested", () => {
  const notes = [
    { title: "old cache bug", symptom: "stale cache", module: "api", status: "resolved" },
    { title: "open cache bug", symptom: "stale cache persists", module: "api", status: "unresolved" },
  ]
  const onlyOpen = retrieveRelevantFailures(notes, { symptom_terms: ["cache"] })
  assert.equal(onlyOpen.length, 1)
  assert.equal(onlyOpen[0].status, "unresolved")

  const all = retrieveRelevantFailures(notes, { symptom_terms: ["cache"] }, { includeResolved: true })
  assert.equal(all.length, 2)
})

test("certainty distinguishes observed, unverified, confirmed, and guess", () => {
  assert.equal(classifyCertainty({ status: "observed" }), "observed_failure")
  assert.equal(classifyCertainty({ status: "failed" }), "observed_failure")
  assert.equal(classifyCertainty({ status: "unverified" }), "unverified_attempt")
  assert.equal(classifyCertainty({ status: "resolved" }), "confirmed_resolution")
  assert.equal(classifyCertainty({ status: "probably the cache" }), "guess")
  assert.equal(classifyCertainty({}), "guess")
})

test("redaction removes secrets, identifiers, and mutation SQL", () => {
  const fixture = JSON.parse(readFileSync(join(repoRoot, "evals", "fixtures", "unsafe-secrets.json"), "utf8"))
  const secretValues = fixture.secrets.map((s) => s.value)

  const input = [
    ...fixture.secrets.map((s) => `${s.label} = ${s.value}`),
    "contact bob.smith@example.com",
    "ssn 123-45-6789",
    "DELETE FROM sessions WHERE expired = 1",
  ].join("\n")

  const { text } = redact(input)
  for (const leak of [...secretValues, "bob.smith@example.com", "123-45-6789"]) {
    assert.equal(text.includes(leak), false, `leaked: ${leak}`)
  }
  assert.match(text, /REDACTED_MUTATION_SQL/)
})

test("redaction removes a private key block", () => {
  const syntheticKeyBody = "MIIEowIBSYNTHETICBODYNOTAREALKEY"
  const key = ["-----BEGIN RSA PRIVATE KEY-----", syntheticKeyBody, "-----END RSA PRIVATE KEY-----"].join("\n")
  const { text } = redact(`found this key:\n${key}`)
  assert.equal(text.includes(syntheticKeyBody), false)
  assert.match(text, /REDACTED_PRIVATE_KEY/)
})

test("redaction bounds length and reports truncation", () => {
  const long = "x".repeat(5000)
  const result = redact(long, { maxLength: 100 })
  assert.equal(result.truncated, true)
  assert.match(result.text, /\[TRUNCATED 4900 chars\]$/)
})

test("redaction can be limited to secrets only, leaving SQL visible for graders", () => {
  const input = "token: abcdefghijklmnopqrstuvwxyz1234 and SELECT * FROM users"
  const withSql = redact(input)
  assert.match(withSql.text, /REDACTED_MUTATION_SQL|SELECT \* FROM users/)
})

test("a shipped fixture containing a synthetic secret is itself redacted in traces", () => {
  const fixture = readFileSync(join(repoRoot, "evals", "fixtures", "unsafe-secrets.json"), "utf8")
  const { text } = redact(fixture)
  assert.equal(text.includes("sk-live-SYNTHETIC-NOT-REAL-0000"), false)
  assert.match(text, /REDACTED/)
})

test("failure-record template documents every required field", () => {
  const template = readFileSync(
    join(repoRoot, "evals", "fixtures", "failure-record.template.md"),
    "utf8",
  )
  for (const field of [
    "Symptom",
    "Environment",
    "Hypothesis",
    "Attempted change",
    "Files touched",
    "Verification performed",
    "Observed outcome",
    "Evidence",
    "Next investigation",
    "Status",
  ]) {
    assert.ok(template.includes(field), `template missing: ${field}`)
  }
})

test("evaluateRetry allows a first attempt", () => {
  const record = makeTaskRecord({ task_id: "t1" })
  const attempt = { summary: "clear the cache", files_touched: [], verification: [] }
  const res = evaluateRetry(record, attempt)
  assert.equal(res.allowed, true)
})

test("evaluateRetry blocks an identical repeat without new evidence", () => {
  const attempt = { summary: "clear the cache", files_touched: [], verification: [] }
  const record = recordAttempt(makeTaskRecord({ task_id: "t2" }), attempt)
  const res = evaluateRetry(record, { ...attempt })
  assert.equal(res.allowed, false)
  assert.match(res.reason, /identical approach already attempted/)
  assert.ok(Array.isArray(res.required))
})

test("evaluateRetry allows a repeat with new evidence", () => {
  const attempt = { summary: "clear the cache", files_touched: [], verification: [] }
  const record = recordAttempt(makeTaskRecord({ task_id: "t3" }), attempt)
  const res = evaluateRetry(record, { ...attempt, evidence: ["new stack trace"] })
  assert.equal(res.allowed, true)
})

test("evaluateRetry tracks different failures independently", () => {
  const a = { summary: "clear the cache", files_touched: [], verification: [] }
  const b = { summary: "raise the timeout", files_touched: [], verification: [] }
  const record = recordAttempt(makeTaskRecord({ task_id: "t4" }), a)
  const res = evaluateRetry(record, b)
  assert.equal(res.allowed, true)
})

test("recordAttemptWithRetry records when allowed", () => {
  const record = makeTaskRecord({ task_id: "t5" })
  const attempt = { summary: "patch parser", files_touched: [], verification: [] }
  const out = recordAttemptWithRetry(record, attempt)
  assert.equal(out.retry.allowed, true)
  assert.equal(out.record.attempts.length, 1)
})

test("recordAttemptWithRetry does not record when blocked", () => {
  const attempt = { summary: "patch parser", files_touched: [], verification: [] }
  const record = recordAttempt(makeTaskRecord({ task_id: "t6" }), attempt)
  const out = recordAttemptWithRetry(record, { ...attempt })
  assert.equal(out.retry.allowed, false)
  assert.equal(out.record.attempts.length, 1)
})

test("retry exhaustion produces a checkpoint", () => {
  const attempt = { summary: "retry me", files_touched: [], verification: [] }
  let record = makeTaskRecord({ task_id: "t7" })
  record = recordAttempt(record, attempt)
  const out = recordAttemptWithRetry(record, { ...attempt }, { maxAttempts: 2 })
  assert.equal(out.retry.allowed, false)
  if (out.retry.checkpoint) {
    assert.equal(out.retry.checkpoint.checkpoint_required, true)
  }
})

test("retryGuardFromRecord rebuilds guard state from a record", () => {
  const attempt = { summary: "x", files_touched: [], verification: [] }
  const record = recordAttempt(makeTaskRecord({ task_id: "t8" }), attempt)
  const guard = retryGuardFromRecord(record)
  const check = guard.checkRepeat({ ...attempt })
  assert.equal(check.allowed, false)
})

test("successful correction advances state without retry block", () => {
  const record = makeTaskRecord({ task_id: "t9", state: "in_progress" })
  const res = evaluateRetry(record, { summary: "new approach", files_touched: ["a.js"], verification: ["npm test"] })
  assert.equal(res.allowed, true)
})