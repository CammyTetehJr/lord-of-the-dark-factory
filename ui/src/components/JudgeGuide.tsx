import { useRef, useState } from 'react'
import { useStored } from '../hooks/useFactory'
import { HoldButton } from './HoldButton'

export type Scenario = 'easy' | 'nasty' | 'rogue' | 'slow'

const SCENARIOS: { id: Scenario; title: string; setup: string; watch: string; hold?: boolean }[] = [
  { id: 'easy', title: 'Fix the easy bugs', setup: 'Bugs 1–5. Reset if already fixed.', watch: 'Watch Deploy: canary traffic goes 10 → 50 → 100%, then the PROD commit changes.', hold: true },
  { id: 'nasty', title: 'Give it a nasty bug', setup: 'Bugs 6 + 7. Unreliable failures and expired keys.', watch: 'Both stop at Scope. Read why in the escalation queue.' },
  { id: 'rogue', title: 'Plug in a bad robot arm', setup: 'Two rogue fixes. Reset if already fixed.', watch: 'bug1: Oracle passes, Diff rejects deleted tests. bug3: checks pass until Review vetoes the cheat.', hold: true },
  { id: 'slow', title: 'Ship something slow', setup: 'Reset, then bug1 with a slow fix.', watch: 'Tests pass. The canary breaches its p95 limit and rolls back automatically; PROD stays unchanged.', hold: true },
]

export function JudgeGuide({ disabled, paused, onTry }: {
  disabled: boolean
  paused: boolean
  onTry: (scenario: Scenario, progress: (message: string) => void) => Promise<string>
}) {
  const [open, setOpen] = useStored('df.guideOpen', true)
  const [active, setActive] = useState<Scenario | 'human'>('easy')
  const [busy, setBusy] = useState(false)
  const running = useRef(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState(false)
  const run = async (id: Scenario) => {
    if (running.current || disabled) return
    running.current = true
    setBusy(true)
    setActive(id)
    setError(false)
    setMessage('Preparing the scenario…')
    try { setMessage(await onTry(id, setMessage)) }
    catch (e) { setError(true); setMessage((e as Error).message) }
    finally { running.current = false; setBusy(false) }
  }

  return (
    <section className="judge-guide" aria-label="Judge guide">
      <button type="button" className="guide-toggle" aria-expanded={open} aria-controls="judge-scenarios" onClick={() => setOpen(!open)}>
        <span><span className="eyebrow">Try this</span><strong>Try to make it fail</strong></span>
        <span>{open ? 'Hide guide −' : 'Show guide +'}</span>
      </button>
      {open && <div id="judge-scenarios" className="guide-body">
        <p className="guide-intro">A bug-fixing robot ships fixes to production with no human approving them. Everything around it decides whether that’s safe. Try to make it fail.</p>
        <p className="note">Scenarios use Live · Nemotron, about 30–60 seconds per bug. Hold buttons for one second where a reset may remove existing fixes.</p>
        {paused && <p className="guide-paused">The line is stopped. Resume it above to watch a scenario run, or leave it stopped to test the human override.</p>}
        <div className="scenario-grid">
          {SCENARIOS.map((s, i) => <article className={`scenario ${active === s.id ? 'selected' : ''}`} key={s.id}>
            <h3><span>{i + 1}</span>{s.title}</h3>
            <p>{s.setup}</p>
            {s.hold ? <HoldButton disabled={disabled || busy} onConfirm={() => run(s.id)} label={`Hold to try: ${s.title}`} title="Hold for one second; this scenario may reset shared production">
              <span className="hold-top">{busy && active === s.id ? 'Preparing…' : 'Hold to try'}</span>
            </HoldButton> : <button type="button" className="btn small" disabled={disabled || busy} onClick={() => run(s.id)}>{busy && active === s.id ? 'Preparing…' : 'Try nasty bugs'}</button>}
          </article>)}
          <article className={`scenario ${active === 'human' ? 'selected' : ''}`}>
            <h3><span>5</span>Be the human</h3>
            <p>Stop, roll back, replay, and verify.</p>
            <button type="button" className="btn small" disabled={busy} onClick={() => { setActive('human'); setMessage(''); setError(false) }}>Show me how</button>
          </article>
        </div>
        {active !== 'human' && <p className="guide-watch"><b>What to look at · </b>{SCENARIOS.find((s) => s.id === active)?.watch}</p>}
        {message && <p className={`guide-status ${error ? 'error' : ''}`} role={error ? 'alert' : 'status'}>{message}</p>}
        {active === 'human' && <ol className="human-guide">
          <li>Hold <b>Stop line</b> in the top bar, then try the nasty bugs. Their runs stop before the first station. Use <b>Resume line</b> when done.</li>
          <li>After an easy bug ships, hold <b>Roll back</b> beside PROD to undo the named fix.</li>
          <li>Click a run’s name or outcome, then <b>Replay this run</b> to recheck its recorded evidence.</li>
          <li>The <b>Chain intact</b> pill above verifies the signed audit record. Hover for the full verification result.</li>
        </ol>}
      </div>}
    </section>
  )
}
