import { createHash } from "node:crypto"
import { existsSync, readFileSync, statSync } from "node:fs"
import { isAbsolute, join, resolve } from "node:path"

function digestOf(path) {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex")
  } catch {
    return null
  }
}

function fingerprintOf(path) {
  try {
    const stats = statSync(path)
    return { size: stats.size, mtime_ms: Math.round(stats.mtimeMs), sha256: digestOf(path) }
  } catch {
    return null
  }
}

/** Reads git metadata without spawning a process, including worktrees where .git is a file. */
export function readGitContext(projectRoot) {
  const gitPath = join(projectRoot, ".git")
  if (!existsSync(gitPath)) return { present: false, head: null, branch: null }

  let gitDir
  try {
    if (statSync(gitPath).isFile()) {
      const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync(gitPath, "utf8"))
      if (!pointer) return { present: true, head: null, branch: null, malformed: true }
      gitDir = resolve(projectRoot, pointer[1].trim())
    } else {
      gitDir = gitPath
    }
  } catch {
    return { present: true, head: null, branch: null }
  }

  const headFile = join(gitDir, "HEAD")
  if (!existsSync(headFile)) return { present: true, head: null, branch: null }
  const head = readFileSync(headFile, "utf8").trim()
  const branch = /^ref:\s*refs\/heads\/(.+)$/.exec(head)?.[1] ?? null

  let commit = null
  if (/^[0-9a-f]{40}$/.test(head)) {
    commit = head
  } else if (branch) {
    const refFile = join(gitDir, "refs", "heads", branch)
    if (existsSync(refFile)) commit = readFileSync(refFile, "utf8").trim()
    else {
      const packed = join(gitDir, "packed-refs")
      if (existsSync(packed)) {
        const line = new RegExp(`^([0-9a-f]{40})\\s+refs/heads/${branch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m").exec(
          readFileSync(packed, "utf8"),
        )
        if (line) commit = line[1]
      }
    }
  }

  return { present: true, head, branch, commit, worktree: statSync(gitPath).isFile() }
}

/**
 * Captures the state of everything the current readiness verdict depends on, so a later
 * evaluation can tell whether that verdict still holds.
 */
export function snapshotContext({ projectRoot, readPaths = [], configPaths = [] }) {
  const files = {}
  for (const path of [...readPaths, ...configPaths]) {
    const key = resolve(path)
    const fingerprint = fingerprintOf(key)
    if (fingerprint) files[key] = fingerprint
  }
  return { project_root: resolve(projectRoot), files, git: readGitContext(projectRoot) }
}

export function diffContext(snapshot, paths = []) {
  const changed = []
  const removed = []

  for (const [path, before] of Object.entries(snapshot.files)) {
    if (!paths.includes(path) && paths.length > 0) continue
    const after = fingerprintOf(path)
    if (!after) {
      removed.push(path)
      continue
    }
    if (after.sha256 !== before.sha256) changed.push(path)
  }

  return { changed, removed }
}

export function contextChanged(snapshot, { projectRoot, readPaths = [], configPaths = [] } = {}) {
  const anchor = projectRoot ?? snapshot.projectRoot
  const relevant = [...readPaths, ...configPaths].map((p) => (isAbsolute(p) ? resolve(p) : resolve(anchor, p)))
  const { changed, removed } = diffContext(snapshot, relevant)
  const gitNow = readGitContext(snapshot.project_root)
  const gitMoved =
    snapshot.git.present !== gitNow.present ||
    snapshot.git.commit !== gitNow.commit ||
    snapshot.git.branch !== gitNow.branch

  // Content-based staleness is the authority: a commit/branch move alone does not invalidate
  // the inspected context when the files that were actually read are unchanged. Git movement
  // is still reported for observability, but it never clears readiness by itself.
  return {
    invalidated: changed.length > 0 || removed.length > 0,
    changed,
    removed,
    git: gitMoved ? { before: snapshot.git, after: gitNow } : null,
  }
}