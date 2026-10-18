// One reducer for both clocks: live mode folds the SSE feed through it, replay folds a slice of
// one run's events. Every component reads FactoryState only, so replay looks exactly like live.
import type { Bug, Evidence, FactoryEvent, Outcome, RunStatus } from '../api/types'

export type StationStatus = 'idle' | 'running' | 'pass' | 'escalate' | 'held' | 'skipped'

export interface StationState {
  status: StationStatus
  startedAt?: string
  finishedAt?: string
  outcome?: Outcome
  reason?: string
  evidence?: Evidence
}

export interface RunState {
  runId: string
  bug: Bug
  fixer: string
  reproducer: string
  stations: string[]
  byStation: Record<string, StationState>
  status: RunStatus
  startedAt: string
  finishedAt?: string
  escalation?: { station: string; reason: string; held: boolean }
  /** set when the pipeline itself crashed (station "factory") */
  crash?: string
  firstSeq: number
  lastSeq: number
}

export interface FactoryState {
  runs: Record<string, RunState>
  /** run ids in start order */
  order: string[]
  lastSeq: number
  eventCount: number
}

export const emptyState: FactoryState = { runs: {}, order: [], lastSeq: 0, eventCount: 0 }

const POST_CHECKS = ['oracle', 'diff_inspection']

/** A station escalated because a human pulled the andon cord (factory/pipeline.py, LinePaused). */
export function isHeld(evidence: Evidence | undefined): boolean {
  return Boolean(evidence && typeof evidence.line === 'object' && evidence.line?.paused)
}

function patchRun(state: FactoryState, runId: string, fn: (r: RunState) => RunState): FactoryState {
  const run = state.runs[runId]
  if (!run) return state
  return { ...state, runs: { ...state.runs, [runId]: fn(run) } }
}

function patchStation(run: RunState, station: string, patch: Partial<StationState>): RunState {
  const prev = run.byStation[station] ?? { status: 'idle' }
  return { ...run, byStation: { ...run.byStation, [station]: { ...prev, ...patch } } }
}

export function apply(state: FactoryState, e: FactoryEvent): FactoryState {
  // SSE reconnects replay from `since`; anything already folded in is ignored.
  if (e.seq <= state.lastSeq) return state
  let next: FactoryState = { ...state, lastSeq: e.seq, eventCount: state.eventCount + 1 }

  switch (e.type) {
    case 'run_started': {
      const run: RunState = {
        runId: e.run_id,
        bug: e.bug,
        fixer: e.fixer,
        reproducer: e.reproducer,
        stations: e.stations,
        byStation: Object.fromEntries(e.stations.map((s) => [s, { status: 'idle' as StationStatus }])),
        status: 'running',
        startedAt: e.ts,
        firstSeq: e.seq,
        lastSeq: e.seq,
      }
      next = { ...next, runs: { ...next.runs, [e.run_id]: run }, order: [...next.order, e.run_id] }
      return next
    }
    case 'station_started':
      return patchRun(next, e.run_id, (r) => ({ ...patchStation(r, e.station, { status: 'running', startedAt: e.ts }), lastSeq: e.seq }))
    case 'station_finished':
      return patchRun(next, e.run_id, (r) => {
        if (e.station === 'factory') return { ...r, crash: e.reason, lastSeq: e.seq }
        const held = e.outcome === 'escalate' && isHeld(e.evidence)
        return {
          ...patchStation(r, e.station, {
            status: held ? 'held' : e.outcome,
            outcome: e.outcome,
            reason: e.reason,
            evidence: e.evidence,
            finishedAt: e.ts,
          }),
          lastSeq: e.seq,
        }
      })
    case 'escalated':
      return patchRun(next, e.run_id, (r) => ({
        ...r,
        escalation: { station: e.station, reason: e.reason, held: r.byStation[e.station]?.status === 'held' },
        lastSeq: e.seq,
      }))
    case 'run_finished':
      return patchRun(next, e.run_id, (r) => {
        const byStation = Object.fromEntries(
          Object.entries(r.byStation).map(([s, st]) => [s, st.status === 'idle' ? { ...st, status: 'skipped' as StationStatus } : st]),
        )
        return { ...r, byStation, status: e.outcome, finishedAt: e.ts, lastSeq: e.seq }
      })
    default:
      return next // unknown event types are counted but otherwise ignored
  }
}

export function fold(events: FactoryEvent[], from: FactoryState = emptyState): FactoryState {
  return events.reduce(apply, from)
}

/** Selecting either post-check shows both: the rogue beat is "oracle passed, diff inspection rejected". */
export function isPostCheck(station: string): boolean {
  return POST_CHECKS.includes(station)
}

export function escalatedRuns(state: FactoryState): RunState[] {
  return state.order
    .map((id) => state.runs[id])
    .filter((r) => r.status === 'escalated')
    .reverse()
}
