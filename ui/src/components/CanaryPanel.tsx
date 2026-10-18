import { motion } from 'motion/react'
import type { Evidence } from '../api/types'
import { canaryFromEvidence, type CanaryState, type CanaryStep, type RunState } from '../state/reducer'

const STAGES = [10, 50, 100]

/** Live state if we saw the progress events, otherwise rebuilt from the finished deploy's evidence. */
export function canaryOf(run: RunState): CanaryState | undefined {
  const d = run.byStation.deploy
  return run.canary ?? canaryFromEvidence(d?.evidence, d?.outcome, d?.reason)
}

function stepState(s: CanaryStep | undefined): 'idle' | 'running' | 'ok' | 'breach' {
  if (!s) return 'idle'
  if (s.ok === undefined) return 'running'
  return s.ok ? 'ok' : 'breach'
}

const ms = (v: number | undefined) => (v == null ? '—' : `${v < 10 ? v.toFixed(1) : Math.round(v)} ms`)

/** Canary p95 against the limit it was judged by. The track is the same hue as the fill, lighter. */
function LatencyMeter({ step }: { step: CanaryStep }) {
  const p95 = step.canary?.p95_ms
  const limit = step.limitMs
  if (p95 == null || limit == null) return <div className="note">Measuring…</div>
  const max = Math.max(limit * 2, p95)
  const state = stepState(step)
  return (
    <div className={`meter lat ${state}`} title={`canary p95 ${ms(p95)} · limit ${ms(limit)} · stable p95 ${ms(step.stable?.p95_ms)}`}>
      <div className="track">
        <motion.div className="fill" initial={{ width: 0 }} animate={{ width: `${(p95 / max) * 100}%` }} transition={{ duration: 0.5, ease: [0.2, 0.8, 0.2, 1] }} />
        <div className="limit" style={{ left: `${(limit / max) * 100}%` }}><span>limit {ms(limit)}</span></div>
      </div>
    </div>
  )
}

function StepRow({ step }: { step: CanaryStep }) {
  const state = stepState(step)
  return (
    <motion.div className={`cstep ${state}`} layout initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }}>
      <div className="cstep-pct">{step.pct}%</div>
      <div className="cstep-figs">
        <div><span className="eyebrow">Canary p95</span><b className={state === 'breach' ? 'bad' : ''}>{ms(step.canary?.p95_ms)}</b></div>
        <div><span className="eyebrow">Stable p95</span><b>{step.stable?.requests ? ms(step.stable.p95_ms) : '—'}</b></div>
        <div><span className="eyebrow">Errors</span><b>{step.canary ? `${(step.canary.error_rate * 100).toFixed(1)}%` : '—'}</b></div>
      </div>
      <LatencyMeter step={step} />
      <div className={`cstep-verdict ${state}`}>
        {state === 'running' ? 'sending traffic…' : state === 'ok' ? '✓ within SLO' : state === 'breach' ? '✗ SLO breached' : ''}
      </div>
    </motion.div>
  )
}

export function CanaryPanel({ canary, evidence, reason, showTable }: {
  canary: CanaryState
  evidence?: Evidence
  reason?: string
  showTable?: boolean
}) {
  const last = canary.steps[canary.steps.length - 1]
  const pct = canary.phase === 'promoted' ? 100 : canary.phase === 'rolled_back' ? 0 : last?.pct ?? 0
  const tone = canary.phase === 'promoted' ? 'ok' : canary.phase === 'rolled_back' ? 'breach' : 'running'
  const headline =
    canary.phase === 'promoted' ? `Promoted to production${canary.commit ? ` as ${canary.commit.slice(0, 7)}` : ''}. Stable now runs this fix.`
      : canary.phase === 'rolled_back' && !canary.steps.length ? 'Never reached production traffic. Stable was never touched.'
      : canary.phase === 'rolled_back' ? 'Rolled back automatically. Stable was never touched.'
        : canary.phase === 'starting' ? 'Building the release and starting the canary next to stable…'
          : `Canary taking ${last?.pct ?? 0}% of production traffic.`

  return (
    <div className={`canary ${tone}`}>
      <div className="canary-h">
        <span className="eyebrow">Canary deploy</span>
        <span className={`tag ${tone === 'ok' ? 'pass' : tone === 'breach' ? 'escalate' : 'running'}`}>
          {canary.phase === 'promoted' ? 'promoted' : canary.phase === 'rolled_back' ? 'rolled back' : canary.phase === 'starting' ? 'starting' : `${last?.pct}% · live`}
        </span>
      </div>
      <p className={`canary-headline ${tone}`}>{headline}</p>
      {canary.phase === 'rolled_back' && (canary.reason || reason) && <p className="note" style={{ margin: '-4px 0 10px' }}>{canary.reason ?? reason}</p>}

      <div className="split" title={`canary ${pct}% · stable ${100 - pct}%`}>
        <div className="split-labels"><span>canary {pct}%</span><span>stable {100 - pct}%</span></div>
        <div className={`meter split-bar ${tone}`}>
          <div className="track">
            <motion.div className="fill" animate={{ width: `${pct}%` }} transition={{ duration: 0.6, ease: [0.2, 0.8, 0.2, 1] }} />
          </div>
        </div>
        <ol className="stages">
          {STAGES.map((p) => {
            const s = canary.steps.find((x) => x.pct === p)
            return <li key={p} className={stepState(s)}><i />{p}%</li>
          })}
          <li className={canary.phase === 'promoted' ? 'ok' : canary.phase === 'rolled_back' ? 'breach' : 'idle'}><i />{canary.phase === 'rolled_back' ? 'rolled back' : 'promoted'}</li>
        </ol>
      </div>

      <div className="csteps">
        {canary.steps.map((s) => <StepRow key={s.pct} step={s} />)}
      </div>

      {showTable && canary.steps.some((s) => s.canary) && (
        <details style={{ marginTop: 12 }}>
          <summary>Step metrics table</summary>
          <div className="tablewrap" style={{ marginTop: 8 }}>
            <table>
              <thead><tr><th>Step</th><th>Side</th><th>Requests</th><th>Errors</th><th>p50</th><th>p95</th><th>Limit</th></tr></thead>
              <tbody>
                {canary.steps.flatMap((s) => (['canary', 'stable'] as const).map((side) => {
                  const m = s[side]
                  return (
                    <tr key={`${s.pct}-${side}`}>
                      <td className="m">{s.pct}%</td><td className="m">{side}</td>
                      <td className="m tnum">{m?.requests ?? '—'}</td><td className="m tnum">{m ? `${m.errors} (${(m.error_rate * 100).toFixed(1)}%)` : '—'}</td>
                      <td className="m tnum">{m?.requests ? ms(m.p50_ms) : '—'}</td><td className="m tnum">{m?.requests ? ms(m.p95_ms) : '—'}</td>
                      <td className="m tnum">{side === 'canary' ? ms(s.limitMs) : ''}</td>
                    </tr>
                  )
                }))}
              </tbody>
            </table>
          </div>
          {evidence?.slo && (
            <p className="note">SLO: error rate at most {(evidence.slo.max_error_rate * 100).toFixed(0)}%; canary p95 at most {evidence.slo.latency_factor}× stable p95 or stable p95 + {evidence.slo.latency_slack_ms} ms, whichever is larger. Stable p95 alone before traffic shifted: {ms(evidence.stable_reference?.p95_ms)}.</p>
          )}
        </details>
      )}
    </div>
  )
}
