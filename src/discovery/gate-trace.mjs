import { appendFileSync, mkdirSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, isAbsolute, join, relative } from "node:path"
import { createHash } from "node:crypto"

const DEFAULT_FILE = join(tmpdir(), "overgeared-skills-gate-decisions.jsonl")

/**
 * Records why the gate allowed or refused a call. Only the decision shape is stored: no file
 * content, no command text, no conversation. Paths are relativized against the project root so a
 * trace never carries an absolute user path.
 */
export function createGateTracer({
  file = process.env.OVERGEARED_SKILLS_GATE_LOG ?? process.env.GENTJIN_GATE_LOG ?? DEFAULT_FILE,
} = {}) {
  let enabled = true

  return {
    get file() {
      return file
    },
    disable() {
      enabled = false
    },
    record({ tool, filePath, projectRoot, allowed, status = null, reasons = [], missing = [], sessionId = null, taskId = null }) {
      if (!enabled) return null
      const root = projectRoot ?? null
      const absolute = filePath ? String(filePath) : null
      const relativePath = absolute
        ? root && isAbsolute(absolute)
          ? relative(root, absolute).replace(/\\/g, "/")
          : absolute
          ? basename(absolute)
          : null
        : null

      const entry = {
        at: new Date().toISOString(),
        tool: tool ?? null,
        decision: allowed ? "allowed" : "refused",
        readiness: status,
        path: relativePath,
        reasons: reasons.slice(0, 4),
        missing: (missing.length ? missing : reasons).slice(0, 8),
        session: sessionId ? anonymize(sessionId) : null,
        task: taskId ? anonymize(taskId) : null,
      }

      try {
        mkdirSync(dirname(file), { recursive: true })
        appendFileSync(file, `${JSON.stringify(entry)}\n`)
      } catch {
        // A failed trace must never block or alter the decision it describes.
      }
      return entry
    },
  }
}

/**
 * Summarizes advisory discovery misses from a gate trace. An advisory miss is an entry whose
 * decision was "allowed" but whose readiness state is not "ready" (i.e. the operation proceeded
 * without complete discovery context). Refusals and ready operations are excluded.
 */
export function anonymize(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex").slice(0, 12)
}

export function summarizeAdvisoryMisses(entries = [], options = {}) {
  const sessionId = options?.sessionId ?? null
  const sessionKey = sessionId ? anonymize(sessionId) : null
  const misses = (entries ?? []).filter((entry) => {
    if (!entry || entry.decision !== "allowed" || !entry.readiness || entry.readiness === "ready") return false
    if (sessionKey) {
      // Only this session's misses; never fall through to other sessions.
      return entry.session === sessionKey
    }
    // No session id supplied: only unattributed entries, so a missing id can never
    // accidentally pull in misses that belong to a different session.
    return entry.session === null
  })

  const byTool = {}
  const byReadiness = {}
  const byMissing = {}
  for (const entry of misses) {
    const tool = entry.tool ?? "unknown"
    byTool[tool] = (byTool[tool] ?? 0) + 1
    const state = entry.readiness
    byReadiness[state] = (byReadiness[state] ?? 0) + 1
    for (const item of entry.missing ?? entry.reasons ?? []) {
      const key = String(item).slice(0, 120)
      byMissing[key] = (byMissing[key] ?? 0) + 1
    }
  }

  return {
    total_entries: (entries ?? []).length,
    advisory_misses: misses.length,
    by_tool: byTool,
    by_readiness: byReadiness,
    by_missing: byMissing,
    sessions: [...new Set(misses.map((e) => e.session).filter(Boolean))].length,
  }
}

export function summarizeGateTrace(entries = []) {
  return summarizeAdvisoryMisses(entries)
}

export function readGateTrace(file = DEFAULT_FILE) {
  let text
  try {
    text = readFileSync(file, "utf8")
  } catch {
    return []
  }
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .filter(Boolean)
}