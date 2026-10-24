import { readdirSync, readFileSync, statSync } from "node:fs"
import { basename, extname, join, relative, resolve, sep } from "node:path"

/** Directories that never contain authored notes and are expensive to walk. */
const IGNORED_DIRECTORIES = new Set([
  ".obsidian",
  ".git",
  ".trash",
  "node_modules",
  ".venv",
  "__pycache__",
  ".cache",
  "dist",
  "build",
])

/** Generated or machine-written files that would only add noise to ranking. */
const IGNORED_FILES = new Set(["memory-index.md.tmp", ".DS_Store", "Thumbs.db"])

const MARKDOWN = new Set([".md", ".markdown"])

/** Canonical note kinds that answer "why" and "what went wrong" questions. */
const CANONICAL_DIRECTORIES = [
  "issues",
  "attempts",
  "architecture/decisions",
  "architecture",
  "changes",
  "patterns",
]

const MAX_NOTE_BYTES = 512 * 1024

/**
 * Walks a vault root and returns authored Markdown notes as relative POSIX-style paths.
 * Symlink cycles, unreadable directories, oversized files, and binary content are skipped
 * rather than thrown, because a partially readable vault must still be searchable.
 */
export function listNotes(vaultRoot) {
  const notes = []
  const seen = new Set()

  const walk = (directory) => {
    let entries
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.name !== ".project-agent.md") continue
      if (IGNORED_FILES.has(entry.name)) continue

      const absolute = join(directory, entry.name)

      if (entry.isDirectory()) {
        if (IGNORED_DIRECTORIES.has(entry.name)) continue
        let real
        try {
          real = statSync(absolute)
        } catch {
          continue
        }
        if (!real.isDirectory()) continue
        walk(absolute)
        continue
      }

      if (!entry.isFile()) continue
      if (!MARKDOWN.has(extname(entry.name).toLowerCase())) continue

      let size = 0
      try {
        size = statSync(absolute).size
      } catch {
        continue
      }
      if (size === 0 || size > MAX_NOTE_BYTES) continue

      const relativePath = relative(vaultRoot, absolute).split(sep).join("/")
      if (seen.has(relativePath)) continue
      seen.add(relativePath)
      notes.push({ path: relativePath, absolute, bytes: size, name: basename(entry.name, extname(entry.name)) })
    }
  }

  walk(vaultRoot)
  return notes.sort((a, b) => a.path.localeCompare(b.path))
}

/** Reads a note and reports whether it is usable text rather than binary content. */
export function readNote(note) {
  let text
  try {
    text = readFileSync(note.absolute, "utf-8")
  } catch {
    return null
  }
  // A NUL byte is the cheapest reliable binary signal; text notes never contain one.
  if (text.includes("\u0000")) return null
  return text
}

/** Splits YAML frontmatter from the Markdown body. */
export function splitFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (!match) return { attributes: {}, body: text }

  const attributes = {}
  for (const line of match[1].split(/\r?\n/)) {
    const entry = /^([A-Za-z0-9_-]+)\s*:\s*(.+?)\s*$/.exec(line.trim())
    if (entry) attributes[entry[1]] = entry[2].replace(/^["']|["']$/g, "").trim()
  }

  return { attributes, body: text.slice(match[0].length) }
}

/** Strips Markdown syntax so scoring sees prose rather than markup. */
export function plainText(text) {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/[*_>#|]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

/** Collects Obsidian wiki-link targets as note names, ignoring anchors and aliases. */
export function wikiLinkTargets(text) {
  const targets = []
  for (const match of text.matchAll(/\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g)) {
    const target = match[1].trim()
    if (target) targets.push(target)
  }
  return [...new Set(targets)]
}

/** True when a candidate link target stays inside the resolved vault. */
export function isInsideVault(vaultRoot, absolutePath) {
  const relativePath = relative(resolve(vaultRoot), resolve(absolutePath))
  return relativePath !== "" && !relativePath.startsWith("..") && !resolve(absolutePath).startsWith(sep)
}

/** Whether a note sits in a canonical, decision-shaped directory. */
export function isCanonical(path) {
  return CANONICAL_DIRECTORIES.some((directory) => path === directory || path.startsWith(`${directory}/`))
}

export { searchNotes } from "./search.mjs"

/** The first prose block of a note, used as its index description when none is declared. */
export function summarize(text, limit = 240) {
  const plain = plainText(splitFrontmatter(text).body)
  if (plain.length <= limit) return plain
  const cut = plain.slice(0, limit)
  const lastStop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("\n"))
  return (lastStop > limit * 0.5 ? cut.slice(0, lastStop + 1) : cut).trim()
}