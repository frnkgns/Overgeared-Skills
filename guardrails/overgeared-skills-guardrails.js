import { evaluateGitCommand } from "../src/guardrails/git-guardrails.mjs"

/**
 * Blocks destructive git commands before OpenCode executes them, using the
 * tool.execute.before hook.
 *
 * OpenCode 2.0.28 requires a definition object with an `id` and an `effect` or `setup` function.
 * The shell tool is named `shell` in V2, so both that name and the V1 `bash` name are matched.
 *
 * This file is NOT installed automatically. Run /setup-git-guardrails to place
 * it in ~/.config/opencode/plugins/.
 */
const SHELL_TOOLS = new Set(["bash", "shell"])

export default {
  id: "overgeared-skills-guardrails",

  async setup(ctx) {
    await ctx.tool.hook("execute.before", async (event) => {
      if (!event?.tool || !SHELL_TOOLS.has(event.tool)) return
      const command = (event.input ?? {}).command
      if (typeof command !== "string") return

      // Push protection is enforced by default. An agent-editable authorization file is NOT a
      // trustworthy boundary, so the guardrail never reads one automatically. A human may still
      // bypass via the documented per-session environment override (set before launching OpenCode),
      // or by running the push outside the agent.
      const verdict = evaluateGitCommand(command)
      if (!verdict.blocked) return

      throw new Error(
        [
          `Blocked by Overgeared Skills git guardrails (${verdict.rule}).`,
          `Reason: ${verdict.reason}`,
          `Matched: ${verdict.allMatched.join(", ")}`,
          verdict.override,
          "Ask the user for explicit authorization, or run /setup-git-guardrails to remove this guardrail.",
        ].join("\n"),
      )
    })
  },
}