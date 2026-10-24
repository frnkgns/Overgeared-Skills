import test from "node:test"
import assert from "node:assert/strict"
import {
  consumeAuthorization,
  createAuthorization,
  evaluateGitCommand,
  guardrailRules,
  validateAuthorization,
} from "../src/guardrails/git-guardrails.mjs"
import guardrailPlugin from "../guardrails/overgeared-skills-guardrails.js"

function withAllow(value, fn) {
  const previous = process.env.OVERGEARED_SKILLS_ALLOW_GIT
  if (value === undefined) delete process.env.OVERGEARED_SKILLS_ALLOW_GIT
  else process.env.OVERGEARED_SKILLS_ALLOW_GIT = value
  try {
    return fn()
  } finally {
    if (previous === undefined) delete process.env.OVERGEARED_SKILLS_ALLOW_GIT
    else process.env.OVERGEARED_SKILLS_ALLOW_GIT = previous
  }
}

test("plain git push is blocked", () => {
  const v = evaluateGitCommand("git push origin main")
  assert.equal(v.blocked, true)
  assert.equal(v.rule, "push")
})

test("force push is blocked and reported as the stronger rule", () => {
  const v = evaluateGitCommand("git push --force origin main")
  assert.equal(v.blocked, true)
  assert.equal(v.rule, "push-force")
  assert.ok(v.allMatched.includes("push"))
})

test("destructive history and worktree commands are blocked", () => {
  for (const command of [
    "git reset --hard HEAD~1",
    "git clean -fd",
    "git clean -fdx",
    "git branch -D feature/x",
    "git checkout .",
    "git restore .",
  ]) {
    assert.equal(evaluateGitCommand(command).blocked, true, `should block: ${command}`)
  }
})

test("ordinary git commands pass through", () => {
  for (const command of [
    "git status",
    "git diff --stat",
    "git log --oneline -5",
    "git add -A",
    "git commit -m 'fix: guard rails'",
    "git checkout main",
    "git branch -d feature/x",
  ]) {
    assert.equal(evaluateGitCommand(command).blocked, false, `should allow: ${command}`)
  }
})

test("non-git shell commands are untouched", () => {
  for (const command of ["npm test", "ls -la", "echo done", ""]) {
    assert.equal(evaluateGitCommand(command).blocked, false, command)
  }
})

test("a blocked command inside a compound shell line is still caught", () => {
  const v = evaluateGitCommand("cd repo && git push origin main")
  assert.equal(v.blocked, true)
})

test("an explicit per-session override allows exactly that rule", () => {
  withAllow("push", () => {
    assert.equal(evaluateGitCommand("git push origin main").blocked, false)
    assert.equal(evaluateGitCommand("git reset --hard").blocked, true)
  })
})

test("allowing push does not allow force push", () => {
  withAllow("push", () => {
    assert.equal(evaluateGitCommand("git push origin main").blocked, false)
    const forced = evaluateGitCommand("git push --force origin main")
    assert.equal(forced.blocked, true)
    assert.equal(forced.rule, "push-force")
  })
})

test("allowing push does not allow a second destructive command in the same line", () => {
  withAllow("push", () => {
    const v = evaluateGitCommand("git push origin main && git reset --hard HEAD~1")
    assert.equal(v.blocked, true)
    assert.equal(v.rule, "reset-hard")
  })
})

test("every rule carries a reason", () => {
  for (const rule of guardrailRules) {
    assert.equal(typeof rule.id, "string")
    assert.ok(rule.why.length > 10, `${rule.id} needs a real reason`)
  }
})

test("the guardrail plugin exports only the definition object OpenCode 2 requires", async () => {
  const mod = await import("../guardrails/overgeared-skills-guardrails.js")
  assert.deepEqual(Object.keys(mod), ["default"])
  assert.equal(guardrailPlugin.id, "overgeared-skills-guardrails")
  assert.equal(typeof guardrailPlugin.setup, "function")
})

async function mountGuardrails() {
  let before = null
  await guardrailPlugin.setup({
    tool: {
      hook: async (name, callback) => {
        if (name === "execute.before") before = callback
        return { dispose: async () => {} }
      },
    },
  })
  return (...args) => before(...args)
}

test("the plugin refuses a blocked command by throwing", async () => {
  const before = await mountGuardrails()
  assert.equal(typeof before, "function")

  await assert.rejects(
    () => before({ tool: "shell", input: { command: "git push origin main" } }),
    /Blocked by Overgeared Skills git guardrails/,
  )
})

test("the plugin lets ordinary commands through without throwing", async () => {
  const before = await mountGuardrails()
  assert.equal(await before({ tool: "shell", input: { command: "git status" } }), undefined)
})

test("the plugin ignores non-shell tools and missing args", async () => {
  const before = await mountGuardrails()
  await before({ tool: "read", input: { filePath: "x" } })
  await before({ tool: "shell", input: {} })
  await before({ tool: "shell", input: { command: 123 } })
  await before({})
})

test("createAuthorization rejects agent-generated approvers", () => {
  const r = createAuthorization({ approved_by: "agent", action: "push", scope: "origin/main" })
  assert.equal(r.ok, false)
  assert.ok(r.errors.some((e) => /human authorizer/i.test(e)))
})

test("createAuthorization rejects missing scope", () => {
  const r = createAuthorization({ approved_by: "human", action: "push" })
  assert.equal(r.ok, false)
  assert.ok(r.errors.some((e) => /scope is required/i.test(e)))
})

test("createAuthorization accepts a valid human authorization", () => {
  const r = createAuthorization({ approved_by: "human", action: "push", scope: "origin/main", repository: "repo", branch: "main" })
  assert.equal(r.ok, true)
  assert.equal(r.token.approved_by, "human")
  assert.equal(r.token.consumed, false)
})

test("a valid authorization permits a matching push", () => {
  const { token } = createAuthorization({ approved_by: "human", action: "push", scope: "origin/main", repository: "repo", branch: "main" })
  const v = evaluateGitCommand("git push origin main", { authorization: token, repository: "repo", branch: "main" })
  assert.equal(v.blocked, false)
})

test("an unauthorized push is still blocked", () => {
  const v = evaluateGitCommand("git push origin main")
  assert.equal(v.blocked, true)
  assert.equal(v.rule, "push")
})

test("force push remains blocked even with authorization", () => {
  const { token } = createAuthorization({ approved_by: "human", action: "push", scope: "origin/main", repository: "repo", branch: "main" })
  const v = evaluateGitCommand("git push --force origin main", { authorization: token, repository: "repo", branch: "main" })
  assert.equal(v.blocked, true)
  assert.equal(v.rule, "push-force")
})

test("validateAuthorization rejects a consumed token (replay)", () => {
  const { token } = createAuthorization({ approved_by: "human", action: "push", scope: "origin/main" })
  const consumed = consumeAuthorization(token)
  const v = validateAuthorization(consumed, {})
  assert.equal(v.ok, false)
  assert.ok(v.errors.some((e) => /consumed/i.test(e)))
})

test("validateAuthorization rejects an expired token", () => {
  const { token } = createAuthorization({ approved_by: "human", action: "push", scope: "origin/main", expires_at: "2020-01-01T00:00:00Z" })
  const v = validateAuthorization(token, {})
  assert.equal(v.ok, false)
  assert.ok(v.errors.some((e) => /expired/i.test(e)))
})

test("validateAuthorization rejects a branch mismatch", () => {
  const { token } = createAuthorization({ approved_by: "human", action: "push", scope: "origin/main", branch: "main" })
  const v = validateAuthorization(token, { branch: "develop" })
  assert.equal(v.ok, false)
  assert.ok(v.errors.some((e) => /branch/i.test(e)))
})

test("validateAuthorization rejects a repository mismatch", () => {
  const { token } = createAuthorization({ approved_by: "human", action: "push", scope: "origin/main", repository: "repo-a" })
  const v = validateAuthorization(token, { repository: "repo-b" })
  assert.equal(v.ok, false)
  assert.ok(v.errors.some((e) => /repository/i.test(e)))
})

test("validateAuthorization rejects an agent-generated approver", () => {
  const token = { approved_by: "agent", action: "push", scope: "origin/main", consumed: false }
  const v = validateAuthorization(token, {})
  assert.equal(v.ok, false)
  assert.ok(v.errors.some((e) => /human authorizer/i.test(e)))
})

test("consumeAuthorization marks the token consumed", () => {
  const { token } = createAuthorization({ approved_by: "human", action: "push", scope: "origin/main" })
  const consumed = consumeAuthorization(token)
  assert.equal(consumed.consumed, true)
  assert.ok(typeof consumed.consumed_at === "string")
  // original untouched
  assert.equal(token.consumed, false)
})

test("the plugin still blocks the legacy V1 bash tool name", async () => {
  const before = await mountGuardrails()
  await assert.rejects(
    () => before({ tool: "bash", input: { command: "git push origin main" } }),
    /Blocked by Overgeared Skills git guardrails/,
  )
})