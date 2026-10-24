const BLOCKED = [
  {
    id: "push",
    pattern: /\bgit\s+push\b/i,
    why: "Pushing publishes work. A valid, unexpired, single-use human authorization is required.",
  },
  {
    id: "push-force",
    pattern: /\bgit\s+push\b.*(--force\b|--force-with-lease\b|-f\b)/i,
    why: "Force pushing overwrites remote history that may be shared.",
  },
  {
    id: "reset-hard",
    pattern: /\bgit\s+reset\s+--hard\b/i,
    why: "Discards uncommitted work irreversibly.",
  },
  {
    id: "clean",
    pattern: /\bgit\s+clean\s+-[a-z]*f/i,
    why: "Deletes untracked files that cannot be recovered from Git.",
  },
  {
    id: "branch-delete-force",
    pattern: /\bgit\s+branch\s+-D(?:\s|$)/,
    why: "Force-deletes a branch, including unmerged commits. Plain -d is allowed.",
  },
  {
    id: "checkout-dot",
    pattern: /\bgit\s+checkout\s+\.\s*$/i,
    why: "Discards all uncommitted changes in the working tree.",
  },
  {
    id: "restore-dot",
    pattern: /\bgit\s+restore\s+\.\s*$/i,
    why: "Discards all uncommitted changes in the working tree.",
  },
]

const HUMAN_APPROVERS = new Set(["human", "user", "ceo"])

function allowedKeys() {
  return new Set(
    String(process.env.OVERGEARED_SKILLS_ALLOW_GIT ?? process.env.GENTJIN_ALLOW_GIT ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  )
}

/**
 * Validates a human authorization token for a git push.
 * The token must name a human approver and the exact action/scope/repository/branch it covers.
 * Agent-generated or self-declared approvals are rejected.
 */
export function createAuthorization(input = {}) {
  const errors = []
  const approver = input.approved_by ?? input.approver ?? input.by
  if (typeof approver !== "string" || !HUMAN_APPROVERS.has(approver.toLowerCase())) {
    errors.push("approved_by must name a human authorizer (human/user/ceo); agent-generated approvals are rejected")
  }
  if (typeof input.action !== "string" || input.action.trim() === "") {
    errors.push("action is required")
  } else if (input.action.trim().toLowerCase() !== "push") {
    errors.push("action must be 'push'")
  }
  if (typeof input.scope !== "string" || input.scope.trim() === "") {
    errors.push("scope is required (e.g. origin/main)")
  }
  const issuedAt = input.issued_at ?? input.issuedAt ?? new Date().toISOString()
  if (Number.isNaN(Date.parse(issuedAt))) {
    errors.push("issued_at must be an ISO-8601 timestamp")
  }
  const expiresAt = input.expires_at ?? input.expiresAt ?? null
  if (expiresAt !== null && Number.isNaN(Date.parse(expiresAt))) {
    errors.push("expires_at must be an ISO-8601 timestamp when present")
  }
  if (input.nonce !== undefined && (typeof input.nonce !== "string" || input.nonce.trim() === "")) {
    errors.push("nonce must be a non-empty string when present")
  }
  if (errors.length > 0) return { ok: false, errors }

  return {
    ok: true,
    token: {
      approved_by: approver.toLowerCase(),
      action: "push",
      scope: input.scope.trim(),
      repository: input.repository ?? null,
      branch: input.branch ?? null,
      issued_at: issuedAt,
      expires_at: expiresAt,
      nonce: input.nonce ?? null,
      consumed: false,
    },
  }
}

export function isExpired(token, now = new Date()) {
  if (!token || !token.expires_at) return false
  const expiry = Date.parse(token.expires_at)
  if (Number.isNaN(expiry)) return true
  return now.getTime() > expiry
}

/**
 * Validates an authorization token against a push command and its context.
 * Returns { ok, errors }.
 */
export function validateAuthorization(token, context = {}) {
  const errors = []
  if (!token || typeof token !== "object") {
    errors.push("missing authorization token")
    return { ok: false, errors }
  }
  if (token.consumed === true) {
    errors.push("authorization has already been consumed (single-use)")
  }
  const approver = token.approved_by
  if (typeof approver !== "string" || !HUMAN_APPROVERS.has(approver.toLowerCase())) {
    errors.push("approved_by is not a human authorizer")
  }
  if (token.action !== "push") {
    errors.push(`action must be 'push', got ${token.action}`)
  }
  if (isExpired(token)) {
    errors.push("authorization has expired")
  }

  // Scope must match the command's target when we can determine it.
  const scope = String(token.scope ?? "").trim()
  if (scope === "") {
    errors.push("authorization scope is empty")
  } else {
    // scope is like "origin/main" or "origin main"; extract branch
    const scopeBranch = scope.split(/[\/\s]+/).pop()
    if (context.branch && scopeBranch && scopeBranch !== context.branch) {
      errors.push(`authorization scope branch '${scopeBranch}' does not match target branch '${context.branch}'`)
    }
  }
  if (token.repository && context.repository && token.repository !== context.repository) {
    errors.push(`authorization repository '${token.repository}' does not match target repository '${context.repository}'`)
  }
  if (token.branch && context.branch && token.branch !== context.branch) {
    errors.push(`authorization branch '${token.branch}' does not match target branch '${context.branch}'`)
  }

  return { ok: errors.length === 0, errors }
}

export function consumeAuthorization(token) {
  if (!token || typeof token !== "object") return token
  return { ...token, consumed: true, consumed_at: new Date().toISOString() }
}

const DANGEROUS_PUSH_FLAGS = ["--all", "--mirror", "--tags", "--delete", "--prune"]

export function resolvePushCommand(command) {
  const text = String(command ?? "").trim()
  const errors = []
  if (!/\bgit\s+push\b/.test(text)) {
    return { ok: false, errors: ["not a push command"], remote: null, branch: null, refspec: null, flags: [] }
  }

  const flags = DANGEROUS_PUSH_FLAGS.filter((f) =>
    new RegExp(`(?:^|\\s)${f.replace(/[.*+?^${}()|[\\]]/g, "\\$&")}(?:\\s|$)`).test(text),
  )
  if (flags.length > 0) {
    errors.push(`unsupported dangerous push flag(s): ${flags.join(", ")}`)
  }

  const withoutFlags = text.replace(/--?[a-zA-Z-]+(?:=\S+)?/g, "").replace(/\s+/g, " ").trim()
  const m = /\bgit\s+push\s*(.*)$/.exec(withoutFlags)
  const rest = (m ? m[1] : "").trim()
  const tokens = rest.split(/\s+/).filter(Boolean)

  let remote = null
  let refspec = null
  if (tokens.length === 0) {
    errors.push("ambiguous push: no remote specified (bare 'git push' is not allowed)")
  } else {
    remote = tokens[0]
    if (tokens.length >= 2) refspec = tokens[1]
  }

  let branch = null
  if (refspec) {
    const dst = refspec.includes(":") ? refspec.split(":").pop() : refspec
    branch = dst && dst !== "" ? dst : null
  }

  if (errors.length > 0) {
    return { ok: false, errors, remote, branch, refspec, flags }
  }
  return { ok: true, errors: [], remote, branch, refspec, flags }
}

function parsePushTarget(command) {
  const resolved = resolvePushCommand(command)
  return { remote: resolved.remote, branch: resolved.branch }
}

export function evaluateGitCommand(command, context = {}) {
  const text = String(command ?? "")
  if (!/\bgit\b/.test(text)) return { blocked: false }

  const allowed = allowedKeys()
  const authorization = context.authorization ?? null
  const resolvedPush = resolvePushCommand(text)
  const pushTarget = { remote: resolvedPush.remote, branch: resolvedPush.branch }

  // Reject ambiguous or unsupported push commands rather than guessing.
  if (/\\bgit\\s+push\\b/.test(text) && !resolvedPush.ok) {
    return {
      blocked: true,
      rule: "push",
      reason: resolvedPush.errors.join("; "),
      allMatched: ["push"],
      override: "Specify an explicit remote and branch, e.g. 'git push origin main'.",
    }
  }

  // Resolve effective branch: explicit context wins, else parsed from command.
  const effectiveBranch = context.branch ?? pushTarget.branch ?? null
  const effectiveRepository = context.repository ?? null

  const hits = BLOCKED.filter((rule) => {
    if (allowed.has(rule.id)) return false
    // The push rule is conditionally allowed by a valid authorization.
    if (rule.id === "push" && authorization) {
      const validation = validateAuthorization(authorization, {
        branch: effectiveBranch,
        repository: effectiveRepository,
      })
      if (validation.ok) return false
    }
    return rule.pattern.test(text)
  })

  // Force-push is never authorized (always blocked if matched).
  // (Already in BLOCKED; authorization does not bypass push-force.)

  if (hits.length === 0) return { blocked: false }

  const forced = hits.find((h) => h.id === "push-force")
  const matched = forced ?? hits[0]

  return {
    blocked: true,
    rule: matched.id,
    reason: matched.why,
    allMatched: hits.map((h) => h.id),
    override: `Set OVERGEARED_SKILLS_ALLOW_GIT=${matched.id} for this session only if you are certain.`,
  }
}

export const guardrailRules = BLOCKED.map((r) => ({ id: r.id, why: r.why }))