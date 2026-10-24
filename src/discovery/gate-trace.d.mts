export interface GateTraceEntry {
  at: string
  tool: string | null
  decision: "allowed" | "refused"
  readiness: string | null
  path: string | null
  reasons: string[]
  missing: string[]
  session: string | null
  task: string | null
}

export interface GateTracer {
  readonly file: string
  disable(): void
  record(entry: {
    tool?: string
    filePath?: string
    projectRoot?: string | null
    allowed: boolean
    status?: string | null
    reasons?: string[]
    missing?: string[]
    sessionId?: string | null
    taskId?: string | null
  }): GateTraceEntry | null
}

export function createGateTracer(options?: { file?: string }): GateTracer
export function readGateTrace(file?: string): GateTraceEntry[]
export function anonymize(value: unknown): string
export function summarizeAdvisoryMisses(
  entries?: GateTraceEntry[],
  options?: { sessionId?: string | null },
): {
  total_entries: number
  advisory_misses: number
  by_tool: Record<string, number>
  by_readiness: Record<string, number>
  by_missing: Record<string, number>
  sessions: number
}
export function summarizeGateTrace(
  entries?: GateTraceEntry[],
  options?: { sessionId?: string | null },
): ReturnType<typeof summarizeAdvisoryMisses>