import { stationInfo } from '../lib/stations'
import { isPostCheck, type RunState, type StationState } from '../state/reducer'
import { CanaryPanel, canaryOf } from './CanaryPanel'
import { StationEvidence } from './Evidence'

function Block({ station, st }: { station: string; st: StationState }) {
  const info = stationInfo(station)
  return (
    <div className={`ev ${info.kind === 'model' ? 'model' : ''}`}>
      <h4>{info.label} {st.status !== 'idle' && <span className={`tag ${st.status === 'skipped' ? '' : st.status}`}>{st.status}</span>}</h4>
      <StationEvidence station={station} st={st} compact />
    </div>
  )
}

export function Inspector({ run, station, onOpen }: { run: RunState | null; station: string | null; onOpen: (runId: string) => void }) {
  if (!run || !station) {
    return (
      <section className="inspector" aria-live="polite">
        <div className="eyebrow">Inspector</div>
        <p className="note">Click any lamp to see why it lit the way it did.</p>
      </section>
    )
  }
  const st = run.byStation[station] ?? { status: 'idle' }
  const o = run.byStation.oracle
  const d = run.byStation.diff_inspection
  const pair = isPostCheck(station) && (o?.evidence || d?.evidence)
  const info = stationInfo(station)

  let reason = st.reason
  let tone: string = st.status
  if (pair) {
    if (o?.outcome === 'pass' && d?.outcome === 'escalate') {
      reason = 'The tests alone would have shipped this. Diff inspection caught it.'
      tone = 'escalate'
    } else {
      reason = (d?.outcome === 'escalate' ? d.reason : o?.outcome === 'escalate' ? o.reason : d?.reason ?? o?.reason) ?? ''
      tone = d?.outcome === 'escalate' || o?.outcome === 'escalate' ? 'escalate' : 'pass'
    }
  }

  return (
    <section className="inspector" aria-live="polite">
      <div className="chips" style={{ justifyContent: 'space-between' }}>
        <span className="eyebrow">{run.bug.id} · {run.fixer} · {pair ? 'post-checks, side by side' : station === 'scope' ? 'rules, then model votes (escalate only)' : station === 'deploy' && run.deploy === 'canary' ? 'canary against production' : info.kind === 'model' ? 'model station' : 'deterministic gate'}</span>
        <button type="button" className="btn small ghost" onClick={() => onOpen(run.runId)}>Open run</button>
      </div>
      <h2 className="insp-title">{pair ? 'Oracle vs diff check' : info.label}</h2>
      {reason ? <p className={`reason ${tone}`}>{reason}</p> : <p className="reason note">{info.question}</p>}
      {pair ? (
        <div className="pair">
          <Block station="oracle" st={o ?? { status: 'idle' }} />
          <Block station="diff_inspection" st={d ?? { status: 'idle' }} />
        </div>
      ) : station === 'deploy' && canaryOf(run) ? (
        <div className="ev"><CanaryPanel canary={canaryOf(run)!} evidence={st.evidence} reason={st.reason} /></div>
      ) : (
        <Block station={station} st={st} />
      )}
    </section>
  )
}
