import { describe, expect, it } from 'vitest'
import type { FactoryEvent } from '../api/types'
import { apply, emptyState, escalatedRuns, fold } from './reducer'

const STATIONS = ['scope', 'baseline', 'reproduce', 'fix', 'oracle', 'diff_inspection', 'deploy']
let seq = 0
const base = (run_id: string) => ({ seq: ++seq, ts: `2026-10-18T10:00:${String(seq).padStart(2, '0')}.000+00:00`, run_id, prev_hash: '', hash: '' })

const started = (run: string): FactoryEvent => ({
  ...base(run), type: 'run_started', bug: { id: 'bug1', title: 'T', body: '' }, fixer: 'reference', reproducer: 'dev', stations: STATIONS,
})
const st = (run: string, station: string): FactoryEvent => ({ ...base(run), type: 'station_started', station })
const fin = (run: string, station: string, outcome: 'pass' | 'escalate', evidence = {}): FactoryEvent => ({
  ...base(run), type: 'station_finished', station, outcome, reason: `${station} ${outcome}`, evidence,
})

describe('reducer', () => {
  it('lights stations in order and ships', () => {
    const evs: FactoryEvent[] = [started('r1')]
    for (const s of STATIONS) evs.push(st('r1', s), fin('r1', s, 'pass'))
    evs.push({ ...base('r1'), type: 'run_finished', outcome: 'shipped' })
    const s = fold(evs)
    expect(s.runs.r1.status).toBe('shipped')
    expect(Object.values(s.runs.r1.byStation).every((x) => x.status === 'pass')).toBe(true)
  })

  it('marks unreached stations as skipped after an escalation', () => {
    const s = fold([
      started('r2'), st('r2', 'scope'), fin('r2', 'scope', 'escalate'),
      { ...base('r2'), type: 'escalated', station: 'scope', reason: 'auth' },
      { ...base('r2'), type: 'run_finished', outcome: 'escalated' },
    ])
    expect(s.runs.r2.byStation.scope.status).toBe('escalate')
    expect(s.runs.r2.byStation.deploy.status).toBe('skipped')
    expect(s.runs.r2.escalation).toEqual({ station: 'scope', reason: 'auth', held: false })
    expect(escalatedRuns(s).map((r) => r.runId)).toEqual(['r2'])
  })

  it('recognises an andon stop as held, not a failure', () => {
    const s = fold([
      started('r3'),
      fin('r3', 'scope', 'escalate', { line: { paused: true, by: 'ops', reason: 'demo' } }),
      { ...base('r3'), type: 'escalated', station: 'scope', reason: 'Line paused by a human operator before this station.' },
    ])
    expect(s.runs.r3.byStation.scope.status).toBe('held')
    expect(s.runs.r3.escalation?.held).toBe(true)
  })

  it('records a pipeline crash without inventing a station', () => {
    const s = fold([started('r4'), fin('r4', 'factory', 'escalate')])
    expect(s.runs.r4.crash).toBe('factory escalate')
    expect(s.runs.r4.byStation.factory).toBeUndefined()
  })

  it('follows a canary through its steps to a rollback', () => {
    const prog = (phase: string, extra = {}): FactoryEvent => ({ ...base('r6'), type: 'deploy_progress', station: 'deploy', phase, ...extra } as FactoryEvent)
    const m = (p95: number) => ({ requests: 80, errors: 0, error_rate: 0, p50_ms: 2, p95_ms: p95 })
    const s = fold([
      started('r6'), st('r6', 'deploy'),
      prog('starting_canary'),
      prog('canary_step', { canary_pct: 10 }),
      prog('canary_step_finished', { canary_pct: 10, ok: false, detail: 'p95 latency 144.4 ms > limit 17.3 ms (stable p95 7.3 ms)', canary: m(144.4), stable: m(6.6) }),
      prog('rolled_back', { reason: 'Canary breached SLO at 10% traffic.' }),
    ])
    const c = s.runs.r6.canary!
    expect(c.phase).toBe('rolled_back')
    expect(c.steps).toHaveLength(1)
    expect(c.steps[0]).toMatchObject({ pct: 10, ok: false, limitMs: 17.3 })
    expect(c.reason).toBe('Canary breached SLO at 10% traffic.')
  })

  it('ignores events it has already seen (SSE reconnect)', () => {
    const e = started('r5')
    const once = apply(emptyState, e)
    expect(apply(once, e)).toBe(once)
  })
})
