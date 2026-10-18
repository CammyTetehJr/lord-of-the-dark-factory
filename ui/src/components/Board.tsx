import { GROUP_NOTE, groupsOf, stationInfo } from '../lib/stations'
import type { RunState, StationState } from '../state/reducer'

export interface Selection {
  runId: string
  station: string
}

const OK = (
  <svg className="ok" viewBox="0 0 16 16" aria-hidden="true" style={{ position: 'absolute' }}>
    <path d="M3 8.5l3 3 7-7" fill="none" stroke="var(--pass-ink)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)
const EQ = (
  <svg className="eq" viewBox="0 0 16 16" aria-hidden="true" style={{ position: 'absolute' }}>
    <path d="M4 6h8M4 10h8" fill="none" stroke="var(--closed-ink)" strokeWidth="2.2" strokeLinecap="round" />
  </svg>
)
const X = (
  <svg className="x" viewBox="0 0 16 16" aria-hidden="true" style={{ position: 'absolute' }}>
    <path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="var(--halt-ink)" strokeWidth="2.2" strokeLinecap="round" />
  </svg>
)

export function Lamp() {
  return <span className="lamp">{OK}{X}{EQ}</span>
}

/** The model reviewer was switched off for this run (dev mode). It passed, but nobody reviewed. */
export function isOff(st: StationState): boolean {
  return st.status === 'pass' && st.evidence?.reviewer === 'disabled'
}

function elapsed(st: StationState, now: number): string {
  if (st.status !== 'running' || !st.startedAt) return ''
  const s = Math.max(0, (now - Date.parse(st.startedAt)) / 1000)
  return s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m${String(Math.floor(s % 60)).padStart(2, '0')}`
}

function Outcome({ run, onOpen }: { run: RunState; onOpen: () => void }) {
  const esc = run.escalation
  const cls = run.crash ? 'crash' : esc?.held ? 'held' : run.status
  const label = run.crash ? 'crashed' : esc?.held ? 'stopped' : run.status
  return (
    <button type="button" className={`outcome ${cls}`} onClick={onOpen} title="Open run detail">
      {label}
      <small>{run.crash ? 'pipeline error' : esc ? `at ${stationInfo(esc.station).label}` : run.closed ? 'already fixed' : run.status === 'running' ? 'in progress' : 'open run →'}</small>
    </button>
  )
}

export function Board({ runs, stations, selected, myRuns = [], onSelect, onOpen, now }: {
  runs: RunState[]
  stations: string[]
  selected: Selection | null
  myRuns?: string[]
  onSelect: (s: Selection) => void
  onOpen: (runId: string) => void
  now: number
}) {
  // The outcome is the most important cell on a lane: its column sizes to its content and is never squeezed.
  const cols = `minmax(150px, 1.5fr) repeat(${stations.length}, minmax(50px, 1fr)) max-content`
  return (
    <div className="boardwrap">
      <div className="board" role="grid" aria-label="Runs by station" style={{ gridTemplateColumns: cols }}>
        <div />
        {groupsOf(stations).map((g, i) => (
          <div key={i} className={`grp ${g.kind === 'model' ? 'model' : ''}`} style={{ gridColumn: `span ${g.span}` }}>
            {g.group}{GROUP_NOTE[g.group] && <em>{GROUP_NOTE[g.group]}</em>}
          </div>
        ))}
        <div />
        <div className="colh l">Run</div>
        {stations.map((s) => {
          const info = stationInfo(s)
          return <div key={s} className={`colh ${info.kind === 'model' ? 'model' : ''}`} title={info.question}>{info.label}</div>
        })}
        <div className="colh l">Outcome</div>

        {runs.map((run) => (
          <div
            className="lane"
            role="row"
            key={run.runId}
            data-run={run.runId}
            data-bug={run.bug.id}
            data-fixer={run.fixer}
            data-outcome={run.crash ? 'crashed' : run.escalation?.held ? 'stopped' : run.status}
          >
            <button type="button" className="lane-label" onClick={() => onOpen(run.runId)} title={`${run.bug.title}\n${run.runId}`}>
              <span className="chips" style={{ alignItems: 'center' }}>
                <b>{run.bug.id}</b>
                {myRuns.includes(run.runId) && <span className="chip you">you</span>}
                <span className={`chip ${run.fixer.startsWith('rogue') ? 'rogue' : run.fixer === 'nemotron' ? 'model' : ''}`}>{run.fixer}</span>
              </span>
              <span className="t">{run.bug.title}</span>
            </button>
            {stations.map((s, j) => {
              const st = run.byStation[s] ?? { status: 'idle' }
              const info = stationInfo(s)
              const off = isOff(st)
              const fed = st.status !== 'idle' && st.status !== 'skipped'
              const isSel = selected?.runId === run.runId && selected.station === s
              return (
                <button
                  type="button"
                  key={s}
                  role="gridcell"
                  className={`cell ${j === 0 ? 'first' : ''} ${info.kind === 'model' ? 'model' : ''}`}
                  data-station={s}
                  data-status={off ? 'off' : st.status}
                  data-fed={fed}
                  aria-pressed={isSel}
                  aria-label={`${run.bug.id} ${info.label}: ${off ? 'disabled' : st.status}`}
                  title={st.reason ?? info.question}
                  onClick={() => onSelect({ runId: run.runId, station: s })}
                >
                  <span className="belt" />
                  <Lamp />
                  <span className="elapsed">{s === 'deploy' && st.status === 'running' && run.canary?.phase === 'stepping'
                    ? `canary ${run.canary.steps[run.canary.steps.length - 1]?.pct ?? 0}%`
                    : elapsed(st, now)}</span>
                </button>
              )
            })}
            <Outcome run={run} onOpen={() => onOpen(run.runId)} />
          </div>
        ))}
      </div>
    </div>
  )
}
