import { useRef, useState } from 'react'
import { stationInfo } from '../lib/stations'
import type { RunState } from '../state/reducer'

export type Scenario = 'easy' | 'easy-all' | 'nasty' | 'rogue' | 'slow'
export type ScenarioStart = { ids: string[]; note?: string }

const CARDS = [
  { id: 'easy', number: '1', title: 'Ship an easy bug', mode: 'Live · Nemotron · ~45 s', sentence: "A customer can't be found by email. Watch the factory reproduce it, fix it and ship it.", watch: 'Every lamp green; Nemotron calls in the drawer; canary 10 → 50 → 100%; PROD commit changes.' },
  { id: 'nasty', number: '2', title: 'Give it a nasty bug', mode: 'Live · ~15 s', sentence: 'A race condition and an auth bug. Watch it refuse both.', watch: 'Red at Scope with the reason; both land in the escalation queue.' },
  { id: 'rogue', number: '3', title: 'Plug in a cheating robot', mode: 'Deterministic gate + Live reviewer', sentence: "Swap the fixer for one that cheats: it deletes a test, then hardcodes the test's inputs.", watch: 'First: Oracle green, Diff check red. Second: all green until Review vetoes.' },
  { id: 'slow', number: '4', title: 'Ship something slow', mode: '~20 s · no model needed', sentence: 'A correct fix that loads all 50,000 invoices. Every test passes.', watch: 'Canary p95 breaches the limit at 10%; automatic rollback; PROD commit unchanged.' },
] as const

function currentStation(run: RunState): string {
  const active = run.stations.find((s) => run.byStation[s]?.status === 'running')
  return active ? stationInfo(active).label : 'waiting for a slot'
}

function result(run: RunState): string {
  if (run.status === 'running') return `Running · ${currentStation(run)}`
  if (run.status === 'shipped') {
    const sha = run.byStation.deploy?.evidence?.promoted_commit
    return sha ? `Shipped · promoted to production (${String(sha).slice(0, 7)})` : 'Shipped'
  }
  if (run.status === 'closed') return run.closed?.reason ?? 'Closed · already fixed'
  return run.crash ?? run.escalation?.reason ?? 'Escalated'
}

export function JudgeGuide({ open, setOpen, disabled, paused, runs, onTry, onOpen, onHighlight }: {
  open: boolean
  setOpen: (open: boolean) => void
  disabled: boolean
  paused: boolean
  runs: Record<string, RunState>
  onTry: (scenario: Scenario) => Promise<ScenarioStart>
  onOpen: (runId: string) => void
  onHighlight: (control: 'andon' | 'rollback' | 'replay' | 'audit') => void
}) {
  const running = useRef(false)
  const [busy, setBusy] = useState<Scenario | null>(null)
  const [attempts, setAttempts] = useState<Partial<Record<Scenario, ScenarioStart & { error?: string }>>>({})

  const run = async (id: Scenario) => {
    if (running.current || disabled || paused) {
      if (paused) setAttempts((a) => ({ ...a, [id]: { ids: [], error: 'The line is paused by a human. Release the cord to run.' } }))
      return
    }
    running.current = true
    setBusy(id)
    setAttempts((a) => ({ ...a, [id]: { ids: [] } }))
    try {
      const attempt = await onTry(id)
      setAttempts((a) => ({ ...a, [id]: attempt }))
    }
    catch (e) { setAttempts((a) => ({ ...a, [id]: { ids: [], error: (e as Error).message } })) }
    finally { running.current = false; setBusy(null) }
  }

  if (!open) return null
  return (
    <section className="judge-guide" aria-label="Judge guide">
      <div className="guide-head">
        <div><div className="eyebrow">Try this</div><h2>Try to make it fail</h2></div>
        <button type="button" className="btn small ghost" onClick={() => setOpen(false)}>Hide</button>
      </div>
      <p className="guide-intro">A robot fixes bugs and ships them to production with no human approving. Everything around it decides whether that’s safe.</p>
      <div className="scenario-list">
        {CARDS.map((card) => {
          const attempt = attempts[card.id]
          const mine = attempt?.ids.map((id) => runs[id]).filter((r): r is RunState => Boolean(r)) ?? []
          const done = mine.length > 0 && mine.every((r) => r.status !== 'running')
          return <article className="scenario" key={card.id} data-scenario={card.id}>
            <div className="scenario-title"><span>{card.number}</span><h3>{card.title}</h3></div>
            <div className="scenario-mode">{card.mode}</div>
            <p>{card.sentence}</p>
            {!done && <p className="scenario-watch"><b>Watch:</b> {card.watch}</p>}
            {card.id === 'easy' ? <div className="scenario-actions">
              <button type="button" className="btn small" disabled={disabled || busy !== null} onClick={() => run('easy')}>{busy === 'easy' ? 'Starting…' : 'Run'}</button>
              <button type="button" className="text-button" disabled={disabled || busy !== null} onClick={() => run('easy-all')}>{busy === 'easy-all' ? 'Starting all five…' : 'or all five'}</button>
            </div> : <button type="button" className="btn small" disabled={disabled || busy !== null} onClick={() => run(card.id)}>{busy === card.id ? 'Starting…' : 'Run'}</button>}
            {attempt?.note && <p className="scenario-note">{attempt.note}</p>}
            {attempt?.error && <p className="scenario-error" role="alert">{attempt.error}</p>}
            {mine.length > 0 && <ul className="scenario-results">{mine.map((r) => <li key={r.runId} className={r.status === 'running' ? 'running' : r.status === 'shipped' ? 'pass' : 'escalate'}>
              <span><b>{r.bug.id}</b> · {result(r)}</span>
              <button type="button" className="text-button" onClick={() => onOpen(r.runId)}>open run →</button>
            </li>)}</ul>}
          </article>
        })}
        <article className="scenario" data-scenario="human">
          <div className="scenario-title"><span>5</span><h3>Be the human</h3></div>
          <div className="scenario-mode">Governance · no run</div>
          <p>You are on the loop, not in it.</p>
          <div className="human-actions">
            <button type="button" className="text-button" onClick={() => onHighlight('andon')}>Andon cord</button>
            <button type="button" className="text-button" onClick={() => onHighlight('rollback')}>Roll back</button>
            <button type="button" className="text-button" onClick={() => onHighlight('replay')}>Replay</button>
            <button type="button" className="text-button" onClick={() => onHighlight('audit')}>Audit pill</button>
          </div>
        </article>
      </div>
    </section>
  )
}
