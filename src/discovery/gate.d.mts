export interface ResolvedProject {
  project_root: string
  root_source: string
  identity: string
  identity_source: string
  identifier: string
  knowledge_root: string
  knowledge_root_source: string
  git_root: string | null
  git: boolean
  monorepo: boolean
  override_file: string | null
  identity_candidates: { raw: string; source: string }[]
}

export interface DiscoveryRecord {
  schema_version: number
  status: string
  project_root: string
  identity: string
  identifier: string
  knowledge_root: string
  manifests_inspected: string[]
  source_areas: string[]
  memory_retrieval: unknown
  unknowns: string[]
  blockers: string[]
  evidence: unknown[]
}

export interface ReadinessVerdict {
  status: string
  reasons: string[]
}

export interface DiscoveryState {
  sessions: Map<string, unknown>
  current: unknown
}

export function createDiscoveryState(): DiscoveryState
export function beginSession(state: DiscoveryState, sessionId: string, resolution: ResolvedProject): unknown
export function startDiscovery(state: DiscoveryState, sessionId: string): DiscoveryRecord | null
export function recordFor(state: DiscoveryState, sessionId: string): DiscoveryRecord | null
export function noteRead(state: DiscoveryState, sessionId: string, filePath: string): void
export function readsFor(state: DiscoveryState, sessionId: string): string[]
export function declareScope(state: DiscoveryState, sessionId: string, paths?: string[]): string[]
export function recordMemory(state: DiscoveryState, sessionId: string, result: unknown): unknown
export function note(state: DiscoveryState, sessionId: string, text: string): string[]
export function readinessFor(state: DiscoveryState, sessionId: string): ReadinessVerdict
export function isDiscoveryWriteAllowed(state: DiscoveryState, sessionId: string, filePath: string): boolean
export function evaluateGate(args: {
  state: DiscoveryState
  sessionId: string
  tool: string
  filePath?: string
}): { allowed: boolean; reason?: string; status?: string; advisory?: boolean; missing?: string[] }

export interface GateTraceEntry {
  at: string
  tool: string | null
  decision: "allowed" | "refused"
  readiness: string | null
  path: string | null
  reasons: string[]
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
    sessionId?: string | null
    taskId?: string | null
  }): GateTraceEntry | null
}

export function createGateTracer(options?: { file?: string }): GateTracer

export function noteReadFailure(state: DiscoveryState, sessionId: string, filePath: string): boolean
