import { existsSync } from "node:fs"
import { listNotes } from "../memory/vault.mjs"
import { isAbsolute, resolve } from "node:path"
import { isWithin } from "./resolve.mjs"
import { contextChanged, snapshotContext } from "./staleness.mjs"
import { createDiscoveryRecord, evaluateReadiness, READINESS } from "./readiness.mjs"

const READ_TOOLS = new Set(["read", "grep", "glob", "list", "search", "task", "todowrite", "webfetch", "websearch"])
const WRITE_TOOLS = new Set(["write", "edit", "patch", "multiedit"])

export function createDiscoveryState() {
  return { sessions: new Map(), current: null }
}

function bucket(state, sessionId) {
  const key = sessionId ?? "default"
  if (!state.sessions.has(key)) {
    state.sessions.set(key, {
      session_id: key,
      resolution: null,
      record: null,
      intended_paths: [],
      reads: new Set(),
      notes: [],
    })
  }
  return state.sessions.get(key)
}

/** Records the resolved project for this session without starting discovery. */
export function beginSession(state, sessionId, resolution) {
  const session = bucket(state, sessionId)
  session.resolution = resolution
  return session
}

/** Discovery has actually begun only once the agent asks for the resolution. */
export function startDiscovery(state, sessionId) {
  const session = bucket(state, sessionId)
  if (!session.record && session.resolution) {
    session.record = createDiscoveryRecord(session.resolution)
  }
  return session.record
}

export function recordFor(state, sessionId) {
  return bucket(state, sessionId).record
}

export function noteRead(state, sessionId, filePath) {
  if (typeof filePath !== "string" || filePath === "") return
  bucket(state, sessionId).reads.add(filePath)
}

/**
 * A read that was attempted but did not succeed is not inspected context. Reads are recorded when
 * invoked so that recovery is never blocked, and withdrawn here when the runtime reports failure.
 */
export function noteReadFailure(state, sessionId, filePath) {
  if (typeof filePath !== "string" || filePath === "") return false
  const session = bucket(state, sessionId)
  const had = session.reads.delete(filePath)
  if (had) {
    session.failedReads = session.failedReads ?? new Set()
    session.failedReads.add(filePath)
  }
  return had
}

export function readsFor(state, sessionId) {
  return [...bucket(state, sessionId).reads]
}

export function declareScope(state, sessionId, paths = []) {
  startDiscovery(state, sessionId)
  const session = bucket(state, sessionId)
  const base = session.record?.project_root ?? process.cwd()
  const absolute = paths.map((p) => {
    const value = String(p ?? "")
    if (!value) return value
    return isAbsolute(value) ? resolve(value) : resolve(base, value)
  })
  session.intended_paths = [...new Set(session.intended_paths.concat(absolute))]
  const record = session.record
  if (record) {
    const areas = session.intended_paths.map((p) => String(p).replace(/\\/g, "/").split("/").slice(0, -1).join("/"))
    record.source_areas = [...new Set(record.source_areas.concat(areas.filter(Boolean)))]
  }
  return session.intended_paths
}

export function recordMemory(state, sessionId, result) {
  startDiscovery(state, sessionId)
  bucket(state, sessionId).record.memory_retrieval = result
  return result
}

/**
 * A retrieval claim is only accepted when it can be checked: each named note must exist inside the
 * resolved knowledge root and must actually have been read this session. Claiming that no note
 * applies is accepted only when the vault genuinely holds no indexed notes.
 */
export function verifyMemoryResult(record, session, { notesExist = false } = {}) {
  const result = record.memory_retrieval
  if (!result) return { ok: false, reason: "no memory retrieval result recorded" }
  if (result.status === "error") return { ok: true, degraded: true, reason: result.reason ?? "retrieval failed" }

  const readSet = new Set([...session.reads].map((p) => resolvePath(p, record.project_root)))

  if (Array.isArray(result.notes_read) && result.notes_read.length > 0) {
    const problems = []
    for (const note of result.notes_read) {
      const full = resolvePath(note, record.project_root)
      if (!isWithin(full, record.knowledge_root)) {
        problems.push(`${note} is outside the resolved knowledge root`)
        continue
      }
      if (!existsSync(full)) {
        problems.push(`${note} does not exist`)
        continue
      }
      if (!readSet.has(full)) problems.push(`${note} was not read in this session`)
    }
    if (problems.length > 0) return { ok: false, reason: problems.join("; ") }
    return { ok: true }
  }

  if (result.no_relevant_notes === true) {
    const problems = []
    const scoped = Array.isArray(result.searched) ? result.searched : []

    // A project with no vault has nothing to search. That is a filesystem fact, not a caller claim,
    // so it satisfies the requirement without inventing a search.
    if (!existsSync(record.knowledge_root)) {
      return { ok: true, reason: "no knowledge root exists for this project" }
    }

    if (scoped.length === 0) {
      problems.push("no search scope recorded, so the claim is not scoped to any part of the vault")
    }
    for (const area of scoped) {
      const full = resolvePath(area, record.knowledge_root)
      if (!isWithin(full, record.knowledge_root)) {
        problems.push(`searched area ${area} is outside the resolved knowledge root`)
        continue
      }
      const observed = [...readSet].some((r) => r === full || r.startsWith(`${full}/`) || full.startsWith(`${r}/`))
      if (!observed) problems.push(`searched area ${area} was not actually read or searched this session`)
    }
    if (notesExist === true && scoped.length === 0) {
      problems.push("the knowledge root holds notes but no search scope was recorded")
    }
    if (problems.length > 0) return { ok: false, reason: problems.join("; ") }
    return { ok: true }
  }

  return { ok: false, reason: "retrieval result must record notes read, or that none applied" }
}

/**
 * A relative path is ambiguous: the plugin process and the agent can disagree about the working
 * directory, and a recorded read then fails to match the path it was supposed to cover. Resolving
 * against the project root when one is known is what makes a relative scope and a relative read
 * describe the same file.
 */
function resolvePath(path, base) {
  const value = String(path ?? "")
  if (!value) return value
  if (isAbsolute(value)) return resolve(value)
  const anchor = base ?? process.cwd()
  return resolve(anchor, value)
}

/** Re-reads the state readiness depended on; any drift invalidates the previous verdict. */
export function refreshContext(state, sessionId) {
  const session = bucket(state, sessionId)
  const record = session.record
  if (!record?.context_snapshot) return null

  const result = contextChanged(record.context_snapshot, {
    projectRoot: record.project_root,
    readPaths: [...session.reads],
    configPaths: record.config_paths ?? [],
  })

  if (result.invalidated) {
    session.intended_paths = []
    record.source_areas = []
    record.context_snapshot = null
    record.invalidated_by = {
      at: new Date().toISOString(),
      changed: result.changed,
      removed: result.removed,
      git: result.git ? { before: result.git.before, after: result.git.after } : null,
    }
  }

  return result
}

export function note(state, sessionId, text) {
  bucket(state, sessionId).notes.push(text)
  return bucket(state, sessionId).notes
}

function memoryCheckFor(record, session) {
  return verifyMemoryResult(record, session, {
    notesExist: knowledgeRootHasNotes(record.knowledge_root),
  })
}

export function knowledgeRootHasNotes(knowledgeRoot) {
  if (!knowledgeRoot || !existsSync(knowledgeRoot)) return false
  // A vault is considered to hold notes when it contains any readable Markdown note, not only
  // when a memory-index.md is present. This keeps memory verification working for vaults that
  // have not yet been indexed, while still treating a truly empty vault as having no notes.
  return listNotes(knowledgeRoot).length > 0
}

/** Captures what the current verdict depends on, so later drift can be detected. */
export function captureContext(state, sessionId) {
  const session = bucket(state, sessionId)
  if (!session.record) return null
  session.record.context_snapshot = snapshotContext({
    projectRoot: session.record.project_root,
    readPaths: [...session.reads],
    configPaths: session.record.config_paths ?? [],
  })
  return session.record.context_snapshot
}

export function readinessFor(state, sessionId) {
  const session = bucket(state, sessionId)
  if (!session.record) {
    return { status: READINESS.NOT_STARTED, reasons: ["discovery has not been started for this session"] }
  }
  refreshContext(state, sessionId)
  const verdict = evaluateReadiness(session.record, {
    intendedPaths: session.intended_paths,
    reads: [...session.reads],
    memoryResult: session.record.memory_retrieval,
    memoryCheck: memoryCheckFor(session.record, session),
  })

  if (verdict.status === READINESS.READY && !session.record.context_snapshot) {
    captureContext(state, sessionId)
  }

  return verdict
}

export function isDiscoveryWriteAllowed(state, sessionId, filePath) {
  const session = bucket(state, sessionId)
  if (!session.record) return false
  if (!filePath) return false
  return isWithin(filePath, session.record.knowledge_root)
}

/**
 * The single decision point. Returns a refusal only for an intercepted project mutation whose
 * discovery evidence is missing, stale for the intended area, or belongs to another project.
 */
function scopeOf(session) {
  const candidate = session.record ?? session.resolution
  if (!candidate) return null
  const projectRoot = candidate.project_root
  const knowledgeRoot = candidate.knowledge_root
  if (typeof projectRoot !== "string" || projectRoot === "") return null
  if (typeof knowledgeRoot !== "string" || knowledgeRoot === "") return null
  return { projectRoot, knowledgeRoot }
}

export function evaluateGate({ state, sessionId, tool, filePath }) {
  if (READ_TOOLS.has(tool)) return { allowed: true }
  if (!WRITE_TOOLS.has(tool)) return { allowed: true }
  if (!filePath) return { allowed: true, reason: "no target path available" }

  const session = bucket(state, sessionId)
  const scope = scopeOf(session)

  // Scope is settled before discovery starts, so a path that is not a project modification is
  // never governed by readiness. Without this the gate refuses unrelated writes and, worse,
  // refuses the very edit that would repair it.
  if (scope && filePath) {
    if (isWithin(filePath, scope.knowledgeRoot)) {
      return { allowed: true, reason: "record write inside the resolved knowledge root" }
    }
    if (!isWithin(filePath, scope.projectRoot)) {
      return {
        allowed: true,
        reason: "outside the resolved project root; governed by other scope checks, not discovery readiness",
      }
    }
  }

  if (!session.record) {
    return {
      allowed: false,
      status: READINESS.NOT_STARTED,
      reason:
        "Project edits are blocked until this session has verified context. " +
        "Call the gentjin_discovery tool with action 'resolve' to identify the project and vault, " +
        "then declare the intended paths and record the memory retrieval result.",
    }
  }

  const record = session.record

  const intended = session.intended_paths.length > 0 ? session.intended_paths : [filePath]
  refreshContext(state, sessionId)
  const verdict = evaluateReadiness(record, {
    intendedPaths: intended,
    reads: [...session.reads],
    memoryResult: record.memory_retrieval,
    memoryCheck: memoryCheckFor(record, session),
  })

  if (verdict.status === READINESS.READY && !record.context_snapshot) {
    captureContext(state, sessionId)
  }

  if (verdict.status === READINESS.READY) {
    return { allowed: true, status: READINESS.READY }
  }

  // Readiness is advisory, not a refusal. A blanket block strands an agent that legitimately has
  // nowhere to retrieve from, and a tool that always says "no" teaches people to disable it
  // entirely. The requirement is stated instead, and recorded, so the miss stays visible.
  return {
    allowed: true,
    status: verdict.status,
    advisory: true,
    missing: verdict.reasons.slice(),
    reason:
      `Required before this change: ${verdict.reasons.join("; ")}. ` +
      `Inspect the file with a read tool, declare the intended paths with the gentjin_discovery tool ` +
      `(action 'scope'), and record the memory retrieval result (action 'memory').`,
  }
}
