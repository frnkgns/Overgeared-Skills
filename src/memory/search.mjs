import { existsSync, realpathSync, statSync } from "node:fs"
import { isAbsolute, resolve, sep } from "node:path"
import { isInsideVault, listNotes, plainText, readNote, splitFrontmatter } from "./vault.mjs"
import { isWithin } from "../discovery/resolve.mjs"

const DEFAULT_LIMIT = 10
const MAX_LIMIT = 50
const K1 = 1.5
const B = 0.75

function tokenize(text) {
  return String(text ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter((t) => t.length > 1)
}

function excerptFor(bodyText, terms, limit = 160) {
  const lower = bodyText.toLowerCase()
  let index = -1
  for (const term of terms) {
    const i = lower.indexOf(term)
    if (i !== -1 && (index === -1 || i < index)) index = i
  }
  if (index === -1) return bodyText.slice(0, limit).trim()
  const start = Math.max(0, index - 40)
  const end = Math.min(bodyText.length, start + limit)
  const snippet = bodyText.slice(start, end).trim()
  return (start > 0 ? "…" : "") + snippet + (end < bodyText.length ? "…" : "")
}

/**
 * Lightweight lexical search over a Markdown Knowledge Vault.
 *
 * Returns ranked results without modifying notes. Uses a weighted BM25-style score
 * over title, path, frontmatter, and body fields. Deterministic and dependency-free.
 *
 * @param {string} vaultRoot
 * @param {string} query
 * @param {{ limit?: number, minScore?: number }} [options]
 * @returns {{ results: Array<{ path: string, score: number, excerpt: string, metadata: Record<string,string> }>, total: number, query_terms: string[] }}
 */
/**
 * Determines whether a candidate vault root is authorized against an allow-list of roots.
 * Uses both lexical containment and realpath comparison to defeat traversal and symlink escapes.
 */
export function isAuthorizedVaultRoot(candidate, allowedRoots = []) {
  if (!candidate || !Array.isArray(allowedRoots) || allowedRoots.length === 0) return false
  const resolvedCandidate = resolve(candidate)
  for (const allowed of allowedRoots) {
    if (!allowed) continue
    const resolvedAllowed = resolve(allowed)
    if (!isWithin(resolvedCandidate, resolvedAllowed)) continue
    // Realpath defense against symlink escapes.
    try {
      const realCandidate = realpathSync(resolvedCandidate)
      const realAllowed = realpathSync(resolvedAllowed)
      if (!isWithin(realCandidate, realAllowed)) continue
    } catch {
      // If realpath fails (path missing), fall back to lexical containment already checked.
    }
    return true
  }
  return false
}

export function searchNotes(vaultRoot, query, options = {}) {
  const root = vaultRoot ? resolve(vaultRoot) : null
  if (!root || !existsSync(root)) {
    return { results: [], total: 0, query_terms: [], reason: "vault not found" }
  }

  if (Array.isArray(options.allowedRoots) && options.allowedRoots.length > 0) {
    if (!isAuthorizedVaultRoot(root, options.allowedRoots)) {
      return { results: [], total: 0, query_terms: [], reason: "unauthorized vault root" }
    }
  }

  const terms = [...new Set(tokenize(query))]
  if (terms.length === 0) {
    return { results: [], total: 0, query_terms: [], reason: "empty query" }
  }

  const limit = Math.max(1, Math.min(MAX_LIMIT, Number(options.limit) || DEFAULT_LIMIT))

  const notes = listNotes(root)
  const docs = []
  for (const note of notes) {
    if (!isInsideVault(root, note.absolute)) continue
    let stat
    try {
      stat = statSync(note.absolute)
    } catch {
      continue
    }
    if (!stat.isFile()) continue
    const text = readNote(note)
    if (text === null) continue
    const { attributes, body } = splitFrontmatter(text)
    const title = attributes.title ?? note.name
    const pathText = note.path
    const frontmatterText = Object.entries(attributes)
      .map(([k, v]) => `${k} ${v}`)
      .join(" ")
    const bodyText = plainText(body)
    const titleText = String(title)

    // Weighted field token counts.
    const fieldTokens = {
      title: tokenize(titleText),
      path: tokenize(pathText),
      frontmatter: tokenize(frontmatterText),
      body: tokenize(bodyText),
    }
    const fieldWeights = { title: 3, path: 2, frontmatter: 1.5, body: 1 }
    const weightedFreq = new Map()
    let docLength = 0
    for (const [field, toks] of Object.entries(fieldTokens)) {
      const w = fieldWeights[field]
      docLength += toks.length * w
      for (const t of toks) {
        weightedFreq.set(t, (weightedFreq.get(t) ?? 0) + w)
      }
    }

    docs.push({
      note,
      attributes,
      titleText,
      bodyText,
      weightedFreq,
      docLength,
    })
  }

  const N = docs.length
  if (N === 0) {
    return { results: [], total: 0, query_terms: terms }
  }

  // Document frequency per term.
  const df = new Map()
  for (const term of terms) {
    let count = 0
    for (const d of docs) {
      if (d.weightedFreq.has(term)) count += 1
    }
    df.set(term, count)
  }

  const avgdl = docs.reduce((s, d) => s + d.docLength, 0) / N

  const scored = docs
    .map((d) => {
      let score = 0
      for (const term of terms) {
        const f = d.weightedFreq.get(term) ?? 0
        if (f === 0) continue
        const n = df.get(term) ?? 0
        const idf = Math.log((N - n + 0.5) / (n + 0.5) + 1)
        const denom = f + K1 * (1 - B + B * (d.docLength / (avgdl || 1)))
        score += idf * ((f * (K1 + 1)) / denom)
      }
      return { d, score }
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      return a.d.note.path.localeCompare(b.d.note.path)
    })

  const minScore = typeof options.minScore === "number" ? options.minScore : 0
  const results = scored
    .filter((x) => x.score >= minScore)
    .slice(0, limit)
    .map((x) => ({
      path: x.d.note.path,
      score: Math.round(x.score * 1000) / 1000,
      excerpt: excerptFor(x.d.bodyText, terms),
      metadata: x.d.attributes,
    }))

  return { results, total: scored.length, query_terms: terms }
}