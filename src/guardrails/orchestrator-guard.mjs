export const ORCHESTRATOR_AGENTS = new Set(["oa-orchestrator"])

export const IMPLEMENTATION_TOOLS = new Set([
  "edit",
  "write",
  "patch",
  "multiedit",
  "shell",
  "bash",
  "execute",
])

export const OVERGEARED_SPECIALISTS = new Set([
  "oa-internal-researcher",
  "oa-external-researcher",
  "oa-ui-ux-designer",
  "oa-frontend-developer",
  "oa-backend-developer",
  "oa-qa-engineer",
  "oa-cybersecurity",
  "oa-devops",
  "oa-git-manager",
])

export function evaluateOrchestratorGuard({ agent, tool, input } = {}) {
  if (!ORCHESTRATOR_AGENTS.has(String(agent ?? ""))) return null

  const name = String(tool ?? "")
  if (IMPLEMENTATION_TOOLS.has(name)) {
    return [
      `Blocked: the primary orchestrator '${agent}' may not use '${name}' directly.`,
      "Delegate the work to the Overgeared specialist who owns it.",
    ].join("\n")
  }

  if (name === "subagent") {
    const target = input && typeof input.agent === "string" ? input.agent : null
    if (!target || !OVERGEARED_SPECIALISTS.has(target)) {
      return [
        `Blocked: the primary orchestrator '${agent}' may delegate only to a registered Overgeared specialist.`,
        `Requested target: '${target ?? "unknown"}'. Valid targets: ${[...OVERGEARED_SPECIALISTS].sort().join(", ")}.`,
      ].join("\n")
    }
  }

  return null
}
