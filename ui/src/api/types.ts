// Shapes served by `factory serve` (factory/server.py). See docs/events.md and docs/ui-handoff.md.

export type Outcome = 'pass' | 'escalate'
export type RunStatus = 'running' | 'shipped' | 'escalated'

export interface Bug {
  id: string
  title: string
  body: string
  source?: string
}

interface Base {
  seq: number
  ts: string
  run_id: string
  prev_hash: string
  hash: string
  /** Ed25519 signing key that signed this entry (factory/signing.py) */
  key_id?: string
  sig?: string
}

// Evidence is station-specific and loosely typed on purpose: the factory adds fields over time.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Evidence = Record<string, any>

export type RunStarted = Base & {
  type: 'run_started'
  bug: Bug
  fixer: string
  reproducer: string
  classifier?: string
  reviewer?: string
  target?: { repo: string; ref: string; commit: string }
  policy?: Record<string, unknown>
  stations: string[]
}
export type StationStarted = Base & { type: 'station_started'; station: string }
export type StationFinished = Base & {
  type: 'station_finished'
  station: string
  outcome: Outcome
  reason: string
  evidence: Evidence
}
export type Escalated = Base & { type: 'escalated'; station: string; reason: string }
export type RunFinished = Base & { type: 'run_finished'; outcome: 'shipped' | 'escalated' }

export type FactoryEvent = RunStarted | StationStarted | StationFinished | Escalated | RunFinished

export interface Meta {
  stations: string[]
  fixers: string[]
  reproducers: string[]
  classifiers?: string[]
  reviewers?: string[]
  deploys?: string[]
  target: { repo: string; ref: string }
}

export interface LineState {
  paused: boolean
  by?: string
  reason?: string
  ts?: string
}

export interface AuditResult {
  ok: boolean
  message: string
  events: number
}

/** Omitted roles default to Nemotron on the server. The free dev preset is reference/dev/none/none. */
export interface RunRequest {
  bug_id: string
  fixer?: string
  reproducer?: string
  classifier?: string
  reviewer?: string
  /** 'canary' (server default) or 'branch' */
  deploy?: string
}

/** POST /api/runs/{id}/replay (factory/replay.py) */
export interface ReplayRow {
  station: string
  kind: 'deterministic' | 'model' | 'recorded'
  recorded: string | null
  replayed: string | null
  match: boolean | null
  note: string
}
export interface ReplayResult {
  run_id: string
  bug: string
  commit: string
  ok: boolean
  outcome: string | null
  integrity: {
    ok: boolean
    events: number
    bad_events: [number, string][]
    artifacts: { artifact: string; ok: boolean }[]
  }
  stations: ReplayRow[]
}

/** A Nemotron call as recorded in evidence (llm.ChatResult.meta) */
export interface ModelCall {
  model: string
  prompt_sha256?: string
  prompt_tokens?: number
  completion_tokens?: number
  seconds?: number
}
