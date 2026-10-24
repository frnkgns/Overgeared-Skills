import { attemptFingerprint, recordAttempt } from "../task/record.mjs"

const DEFAULT_MAX_ATTEMPTS = 3

export class RetryGuard {
  constructor(options = {}) {
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
    this.fingerprints = new Map()
  }

  register(attempt) {
    const fingerprint = attempt.fingerprint ?? attemptFingerprint(attempt)
    const previous = this.fingerprints.get(fingerprint)
    if (previous) {
      this.fingerprints.set(fingerprint, {
        ...previous,
        count: previous.count + 1,
        first_seen: previous.first_seen,
      })
      return { fingerprint, repeated: true, count: previous.count + 1, first_seen: previous.first_seen }
    }
    this.fingerprints.set(fingerprint, { count: 1, first_seen: attempt.id ?? null, summary: attempt.summary ?? null })
    return { fingerprint, repeated: false, count: 1, first_seen: attempt.id ?? null }
  }

  checkRepeat(attempt) {
    const fingerprint = attempt.fingerprint ?? attemptFingerprint(attempt)
    const seen = this.fingerprints.get(fingerprint)
    if (!seen) {
      return { allowed: true, reason: "first attempt at this approach", fingerprint }
    }
    const justification = (attempt.justification ?? "").trim()
    const conditionChanged = attempt.condition_changed === true
    const hasNewEvidence = Array.isArray(attempt.evidence) && attempt.evidence.length > 0

    if (hasNewEvidence || conditionChanged || justification.length >= 10) {
      return {
        allowed: true,
        reason: conditionChanged
          ? "the condition changed since the previous attempt"
          : hasNewEvidence
            ? "new evidence accompanies the repeated approach"
            : "explicit justification explains what differs",
        fingerprint,
        previous_count: seen.count,
      }
    }

    return {
      allowed: false,
      reason:
        `identical approach already attempted ${seen.count} time(s) with no new evidence, ` +
        "no changed condition, and no stated difference",
      fingerprint,
      previous_count: seen.count,
      required: [
        "attach new evidence to the attempt",
        "state what changed about the condition",
        "explain specifically what differs from the earlier attempt",
      ],
    }
  }

  shouldCheckpoint(attemptCount) {
    return attemptCount >= this.maxAttempts
  }

  checkpoint(blocker) {
    return {
      checkpoint_required: true,
      reason: `${this.maxAttempts} attempts exhausted without a verified resolution`,
      state: "blocked",
      blocker: {
        description: blocker,
        blocking: true,
        needs_from_user: true,
        unblock_check: "new information, a changed condition, or a different approach",
      },
      next_step: "stop retrying and request the missing input",
    }
  }
}

export function retrieveRelevantFailures(notes, context, options = {}) {
  const terms = [
    ...(context.symptom_terms ?? []),
    ...(context.module_terms ?? []),
    ...(context.affected_paths ?? []).map((p) => p.split("/").pop().replace(/\.[^.]+$/, "")),
  ].map((t) => String(t).toLowerCase()).filter(Boolean)

  if (terms.length === 0) return []

  const scored = notes.map((note) => {
    const haystack = `${note.title ?? ""} ${note.symptom ?? ""} ${note.module ?? ""} ${(note.tags ?? []).join(" ")}`.toLowerCase()
    const hits = terms.filter((t) => haystack.includes(t))
    return { ...note, matched_terms: hits, match_score: hits.length }
  })

  const threshold = options.threshold ?? 1
  return scored
    .filter((n) => n.match_score >= threshold)
    .filter((n) => n.status !== "resolved" || options.includeResolved === true)
    .sort((a, b) => b.match_score - a.match_score)
}

export function classifyCertainty(note) {
  const status = String(note.status ?? "").toLowerCase()
  if (status === "resolved" || status === "confirmed_resolution") return "confirmed_resolution"
  if (status === "unverified" || status === "attempted" || status === "in_progress") return "unverified_attempt"
  if (status === "observed" || status === "failed") return "observed_failure"
  return "guess"
}

const MUTATION = /\b(insert|update|delete|drop|alter|truncate|replace)\s+(into\s+|from\s+|table\s+)?[\w."`[\]]+/i

export function redact(text, options = {}) {
  const rules = [
    { name: "password", pattern: /(?:password|passwd|pwd)\s*[:=]\s*\S+/gi, replacement: "password=[REDACTED]" },
    { name: "bearer", pattern: /Bearer\s+[A-Za-z0-9._-]{16,}/g, replacement: "Bearer [REDACTED]" },
    { name: "api_key", pattern: /\b(?:api[_-]?key|apikey|secret|token)\s*[:=]\s*["']?[A-Za-z0-9._-]{16,}["']?/gi, replacement: "[REDACTED]" },
    { name: "aws", pattern: /\bAKIA[0-9A-Z]{16}\b/g, replacement: "[REDACTED_AWS_KEY]" },
    { name: "github_token", pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, replacement: "[REDACTED_GITHUB_TOKEN]" },
    { name: "stripe_key", pattern: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{8,}\b/g, replacement: "[REDACTED_STRIPE_KEY]" },
    { name: "openai_key", pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g, replacement: "[REDACTED_API_KEY]" },
    { name: "slack_token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, replacement: "[REDACTED_SLACK_TOKEN]" },
    { name: "google_key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g, replacement: "[REDACTED_GOOGLE_KEY]" },
    { name: "private_key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, replacement: "[REDACTED_PRIVATE_KEY]" },
    { name: "email", pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, replacement: "[REDACTED_EMAIL]" },
    { name: "ssn", pattern: /\b\d{3}-\d{2}-\d{4}\b/g, replacement: "[REDACTED_SSN]" },
    { name: "connection_string", pattern: /\b(?:postgres|postgresql|mysql|mongodb(?:\+srv)?):\/\/[^\s"']+/gi, replacement: "[REDACTED_CONNECTION_STRING]" },
    { name: "mutation_sql", pattern: MUTATION, replacement: "[REDACTED_MUTATION_SQL]" },
  ]

  const extra = options.extra ?? []
  let output = String(text)

  for (const rule of [...rules, ...extra]) output = output.replace(rule.pattern, rule.replacement)

  if (options.forbidSqlMutations) {
    output = output.replace(MUTATION, "[REDACTED_MUTATION_SQL]")
  }

  const maxLength = options.maxLength ?? 2000
  if (output.length > maxLength) {
    return { text: `${output.slice(0, maxLength)}…[TRUNCATED ${output.length - maxLength} chars]`, truncated: true }
  }
  return { text: output, truncated: false }
}

export function retryGuardFromRecord(record, options = {}) {
  const guard = new RetryGuard({ maxAttempts: options.maxAttempts ?? 3 })
  for (const prior of record?.attempts ?? []) guard.register(prior)
  return guard
}

export function evaluateRetry(record, attempt, options = {}) {
  const guard = retryGuardFromRecord(record, options)
  const check = guard.checkRepeat(attempt)
  if (check.allowed) {
    return { allowed: true, reason: check.reason, fingerprint: check.fingerprint }
  }
  const attemptCount = (record?.attempts?.length ?? 0) + 1
  const checkpoint = guard.shouldCheckpoint(attemptCount)
    ? guard.checkpoint(attempt.summary ?? "retry limit reached")
    : null
  return {
    allowed: false,
    reason: check.reason,
    required: check.required,
    fingerprint: check.fingerprint,
    previous_count: check.previous_count,
    checkpoint,
  }
}

export function recordAttemptWithRetry(record, attempt, options = {}) {
  const retry = evaluateRetry(record, attempt, options)
  if (!retry.allowed) return { record, retry }
  return { record: recordAttempt(record, attempt), retry }
}