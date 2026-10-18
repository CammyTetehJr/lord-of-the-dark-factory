import { motion } from 'motion/react'
import { useEffect, useState } from 'react'
import type { FactorySource } from '../api/source'
import type { FactoryEvent, ReplayResult } from '../api/types'
import { shortModel, stationInfo } from '../lib/stations'
import type { RunState } from '../state/reducer'
import { useNow } from '../hooks/useFactory'
import { Crew, Steps } from './Agents'
import { DiffView, modelCalls } from './Evidence'

function Replay({ source, run }: { source: FactorySource; run: RunState }) {
  const [state, setState] = useState<{ busy: boolean; result?: ReplayResult; error?: string }>({ busy: false })
  const go = async () => {
    setState({ busy: true })
    try {
      setState({ busy: false, result: await source.replay(run.runId) })
    } catch (e) {
      setState({ busy: false, error: (e as Error).message })
    }
  }
  const r = state.result
  return (
    <section>
      <h3>Replay</h3>
      <p className="note" style={{ marginTop: 0, maxWidth: '70ch' }}>
        Checks every event's hash and signature, then re-runs each deterministic gate on the recorded commit with the recorded test and diff.
        Model decisions are not re-sampled; their recorded prompt hashes are shown instead.
      </p>
      <button type="button" className="btn replay-control" onClick={go} disabled={state.busy || run.status === 'running'}>
        {state.busy ? 'Replaying… (5 to 10 s)' : r ? 'Replay again' : 'Replay this run'}
      </button>
      {run.status === 'running' && <span className="note" style={{ marginLeft: 10 }}>Available once the run finishes.</span>}
      {state.error && <p className="reason escalate">{state.error}</p>}
      {r && (
        <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} style={{ display: 'grid', gap: 10, marginTop: 12 }}>
          <p className={`reason ${r.ok ? 'pass' : 'escalate'}`} style={{ margin: 0 }}>
            {r.ok ? `Replay matches the record. ${r.integrity.events} events verified, every deterministic gate reached the same outcome.` : 'Replay does not match the record.'}
          </p>
          <div className="chips">
            <span className={`chip ${r.integrity.ok ? 'ok' : 'hit'}`}>{r.integrity.ok ? 'hashes and signatures valid' : `${r.integrity.bad_events.length} bad event(s)`}</span>
            {r.integrity.artifacts.map((a) => <span key={a.artifact} className={`chip ${a.ok ? 'ok' : 'hit'}`}>{a.artifact} {a.ok ? 'matches its recorded hash' : 'was modified'}</span>)}
            <span className="chip">commit {r.commit.slice(0, 10)}</span>
          </div>
          {r.integrity.bad_events.map(([seq, problem]) => <p key={seq} className="reason escalate" style={{ margin: 0 }}>seq {seq}: {problem}</p>)}
          <div className="tablewrap">
            <table>
              <thead><tr><th>Station</th><th>Kind</th><th>Recorded</th><th>Replayed</th><th>Match</th><th>Note</th></tr></thead>
              <tbody>
                {r.stations.map((row) => (
                  <tr key={row.station}>
                    <td className="m">{stationInfo(row.station).label}</td>
                    <td className="m">{row.kind}</td>
                    <td className="m">{row.recorded ?? '—'}</td>
                    <td className="m">{row.replayed ?? '—'}</td>
                    <td className="m">{row.match === true ? <span className="match-yes">✓ same</span> : row.match === false ? <span className="match-no">✗ differs</span> : <span className="match-na">recorded</span>}</td>
                    <td>{row.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </motion.div>
      )}
    </section>
  )
}

export function RunDrawer({ run, events, source, onClose }: { run: RunState; events: FactoryEvent[]; source: FactorySource; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const started = events.find((e) => e.type === 'run_started')
  const testCode: string | undefined = run.byStation.reproduce?.evidence?.test_code
  const diff: string | undefined = run.byStation.fix?.evidence?.diff
  const calls = modelCalls(run.byStation)
  const now = useNow(run.status === 'running', 250)
  const esc = run.escalation

  return (
    <>
      <motion.div className="scrim" onClick={onClose} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} />
      <motion.aside
        className="drawer" role="dialog" aria-modal="true" aria-label={`Run ${run.runId}`}
        initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }} transition={{ type: 'tween', duration: 0.32, ease: [0.2, 0.8, 0.2, 1] }}
      >
        <header className="drawer-h">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span className="eyebrow mono">{run.runId}</span>
            <button type="button" className="btn small ghost" onClick={onClose} autoFocus>Close · Esc</button>
          </div>
          <h2 className="insp-title" style={{ margin: 0 }}>{run.bug.id} · {run.bug.title}</h2>
          <div className="row">
            <span className={`tag ${run.status === 'shipped' ? 'pass' : run.status === 'running' ? 'running' : run.status === 'closed' ? 'closed' : esc?.held ? 'held' : 'escalate'}`}>
              {esc?.held ? 'stopped by andon' : run.status === 'closed' ? 'closed · already fixed' : run.status}
            </span>
            {[['fixer', run.fixer], ['reproducer', run.reproducer], ['classifier', started?.type === 'run_started' ? started.classifier : undefined], ['reviewer', started?.type === 'run_started' ? started.reviewer : undefined]]
              .filter(([, v]) => v)
              .map(([k, v]) => <span key={k} className={`chip ${v === 'nemotron' ? 'model' : String(v).startsWith('rogue') ? 'rogue' : ''}`}>{k}: {v}</span>)}
            {started?.type === 'run_started' && started.target && <span className="chip">commit {started.target.commit.slice(0, 10)}</span>}
          </div>
          {(esc || run.crash || run.closed) && <p className={`reason ${run.closed ? 'closed' : esc?.held ? 'held' : 'escalate'}`} style={{ margin: 0 }}>{run.crash ?? esc?.reason ?? run.closed?.reason}</p>}
        </header>

        <div className="drawer-body">
          <details>
            <summary>Bug report</summary>
            <p style={{ maxWidth: '70ch' }}>{run.bug.body}</p>
          </details>

          <Crew run={run} />
          <Steps key={run.runId} run={run} now={now} />

          {testCode && (
            <section>
              <h3>Reproducing test</h3>
              <pre className="code">{testCode}</pre>
            </section>
          )}
          {diff && (
            <section>
              <h3>Diff</h3>
              <DiffView diff={diff} />
            </section>
          )}

          <details>
            <summary>All model calls ({calls.length})</summary>
            {calls.length === 0 ? (
              <p className="note">No model calls in this run.</p>
            ) : (
              <div className="tablewrap">
                <table>
                  <thead><tr><th>Station</th><th>Role</th><th>Model</th><th>Tokens in / out</th><th>Seconds</th><th>Prompt sha256</th></tr></thead>
                  <tbody>
                    {calls.map((c, i) => (
                      <tr key={i}>
                        <td className="m">{stationInfo(c.station).label}</td>
                        <td>{c.role}</td>
                        <td className="m" style={{ color: 'var(--model-ink)' }}>{shortModel(c.call.model)}</td>
                        <td className="m tnum">{c.call.prompt_tokens?.toLocaleString() ?? '—'} / {c.call.completion_tokens?.toLocaleString() ?? '—'}</td>
                        <td className="m tnum">{c.call.seconds ?? '—'}</td>
                        <td className="m">{c.call.prompt_sha256?.slice(0, 16) ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </details>

          <Replay source={source} run={run} />

          <details>
            <summary>Raw events ({events.length})</summary>
            <pre className="code" style={{ marginTop: 8 }}>{events.map((e) => JSON.stringify(e)).join('\n')}</pre>
          </details>
        </div>
      </motion.aside>
    </>
  )
}
