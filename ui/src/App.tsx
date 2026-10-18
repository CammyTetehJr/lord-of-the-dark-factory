import { AnimatePresence, motion } from 'motion/react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { API_URL } from './api/source'
import type { RunRequest } from './api/types'
import { Andon } from './components/Andon'
import { Board, type Selection } from './components/Board'
import { Inspector } from './components/Inspector'
import { buildRequest, Launcher, prodHasFixFor, type Mode } from './components/Launcher'
import { JudgeGuide, type Scenario } from './components/JudgeGuide'
import { ProdControl } from './components/ProdControl'
import { EventStream, Queue } from './components/Rail'
import { RunDrawer } from './components/RunDrawer'
import { brokenSeq, pickSource, useFactory, useNow, useStored } from './hooks/useFactory'
import { auditLabel } from './lib/audit'
import { escalatedRuns, type RunState } from './state/reducer'

const source = pickSource()
const DEFAULT_STATIONS = ['scope', 'baseline', 'reproduce', 'fix', 'oracle', 'diff_inspection', 'review', 'deploy']
const MAX_LANES = 12

/**
 * "Run all" starts runs in parallel threads, so their run_started events arrive in random order.
 * Run ids start with the second they were created (20261018T113429Z-bug1-…): group by that second,
 * then order by bug number, so a batch always reads bug1, bug2, bug3…
 */
function byBatchThenBug(a: RunState, b: RunState): number {
  const sa = a.runId.slice(0, 16), sb = b.runId.slice(0, 16)
  if (sa !== sb) return a.firstSeq - b.firstSeq
  return a.bug.id.localeCompare(b.bug.id, undefined, { numeric: true }) || a.firstSeq - b.firstSeq
}

/** With nothing selected, follow the action: a running station, else where the latest run stopped. */
function autoSelect(lanes: RunState[]): Selection | null {
  for (let i = lanes.length - 1; i >= 0; i--) {
    const r = lanes[i]
    const running = r.stations.find((s) => r.byStation[s]?.status === 'running')
    if (running) return { runId: r.runId, station: running }
  }
  const last = lanes[lanes.length - 1]
  if (!last) return null
  if (last.escalation) return { runId: last.runId, station: last.escalation.station }
  const done = [...last.stations].reverse().find((s) => last.byStation[s]?.status !== 'idle' && last.byStation[s]?.status !== 'skipped')
  return done ? { runId: last.runId, station: done } : null
}

export default function App() {
  const f = useFactory(source)
  const [mode, setMode] = useStored<Mode>('df.mode', 'dev')
  const [operator, setOperator] = useStored('df.operator', '')
  const [acked, setAcked] = useStored<string[]>('df.acked', [])
  const [clearedAt, setClearedAt] = useState<number | null>(null)
  const cutoff = clearedAt ?? f.visitSeq
  const [picked, setPicked] = useState<Selection | null>(null)
  const [openRun, setOpenRun] = useState<string | null>(null)
  const [launchError, setLaunchError] = useState<string | null>(null)
  const [launchNote, setLaunchNote] = useState<string | null>(null)
  const [scenarioBusy, setScenarioBusy] = useState(false)

  const stations = f.meta?.stations ?? DEFAULT_STATIONS
  const lanes = useMemo(
    () => f.state.order.map((id) => f.state.runs[id]).filter((r) => cutoff !== null && r.firstSeq > cutoff).slice(-MAX_LANES).sort(byBatchThenBug),
    [f.state, cutoff],
  )
  const anyRunning = lanes.some((r) => r.status === 'running')
  const now = useNow(anyRunning)
  const selected = picked && f.state.runs[picked.runId] ? picked : autoSelect(lanes)
  const selRun = selected ? f.state.runs[selected.runId] : null
  const queue = useMemo(() => escalatedRuns(f.state).filter((r) => cutoff !== null && r.firstSeq > cutoff), [f.state, cutoff])
  const broken = brokenSeq(f.audit)

  const onRun = useCallback(async (reqs: RunRequest[]) => {
    setLaunchError(null)
    setLaunchNote(null)
    let started = 0
    let waiting = 0
    let error: string | null = null
    try {
      for (const r of reqs) {
        const res = await source.startRun(r)
        started++
        if ((res.queued_behind ?? 0) > 0) waiting++
      }
    } catch (e) {
      // 429 carries the server's plain-language reason (line busy, hourly cap)
      error = started ? `${started} of ${reqs.length} started. ${(e as Error).message}` : (e as Error).message
      setLaunchError(error)
    }
    // runs beyond the active limit wait their turn; they appear on the board when they start
    if (waiting) setLaunchNote(`${waiting} run${waiting > 1 ? 's are' : ' is'} waiting their turn and will appear on the line when ${waiting > 1 ? 'they start' : 'it starts'}.`)
    return { started, waiting, error }
  }, [])

  const tryScenario = async (scenario: Scenario, progress: (message: string) => void) => {
    setScenarioBusy(true)
    try {
      setMode('live')
      if (scenario !== 'nasty') {
        // Read shared production now: another judge may have changed it since the last poll.
        progress('Checking production…')
        const prod = await source.prod()
        const needsReset = scenario === 'slow' || (scenario === 'easy'
          ? prod.mainline.length > 1 || prod.history.some((h) => h.event === 'promoted' && !h.reverted)
          : ['bug1', 'bug3'].some((id) => prodHasFixFor(prod, f.bugs.find((b) => b.id === id))))
        if (needsReset) {
          progress('Resetting production… Usually 5–10 seconds. The runs will start when it is ready.')
          const reset = await f.prodReset(operator || 'judge')
          if (!reset.ok) throw new Error(`Not reset: ${reset.message}. No scenario runs were started.`)
        }
      }
      progress('Starting Live runs…')
      const reqs = scenario === 'easy' ? ['bug1', 'bug2', 'bug3', 'bug4', 'bug5'].map((id) => buildRequest('live', id))
        : scenario === 'nasty' ? ['bug6', 'bug7'].map((id) => buildRequest('live', id))
        : scenario === 'rogue' ? [buildRequest('live', 'bug1', 'rogue:delete_test'), buildRequest('live', 'bug3', 'rogue:game_test')]
        : [buildRequest('live', 'bug1', 'rogue:slow_fix')]
      const res = await onRun(reqs)
      if (res.error) throw new Error(res.error)
      return `${res.started} Live run${res.started === 1 ? '' : 's'} accepted.${res.waiting ? ` ${res.waiting} waiting their turn.` : ''} Follow the lanes below.`
    } finally { setScenarioBusy(false) }
  }
  useEffect(() => {
    if (!launchNote) return
    const t = setTimeout(() => setLaunchNote(null), 12_000)
    return () => clearTimeout(t)
  }, [launchNote])

  const drawerRun = openRun ? f.state.runs[openRun] : null

  // Missing or expired access code: nothing else on the page can work, so say only that.
  if (source.kind === 'http' && (f.locked || f.errorStatus === 401)) {
    return (
      <main className="locked" role="alert">
        <div className="locked-card">
          <div className="brand">Dark Factory</div>
          <h1>This link needs an access code.</h1>
          <p>Use the full link you were given, including the part that starts with <code>?code=</code>. The code is remembered in this browser for a day.</p>
        </div>
      </main>
    )
  }
  const line = f.line

  return (
    <div className="app">
      <header className="gbar">
        <div className="gbar-status">
          <a className="brand" href={source.kind === 'mock' ? '/?source=mock' : '/'} title="Back to the start (reloads the page)">Dark Factory<small>{source.kind === 'mock' ? 'MOCK DATA' : 'CONTROL ROOM'}</small></a>
          <span className={`pill ${line.paused ? 'stopped' : 'ok'}`} role="status">
            <i />{line.paused ? 'LINE STOPPED' : 'LINE RUNNING'}
          </span>
          <span className={`pill audit-pill ${f.audit ? (f.audit.ok ? 'ok' : 'bad') : ''}`} title={auditLabel(f.audit).title} role="status">
            <i />{auditLabel(f.audit).text}{auditLabel(f.audit).key && <span className="audit-key"> by {auditLabel(f.audit).key}</span>}
          </span>
          {f.stream !== 'open' && <span className="pill warn"><i />{f.stream === 'connecting' ? 'connecting…' : 'reconnecting…'}</span>}
        </div>
        <div className="gbar-controls">
          <ProdControl prod={f.prod} error={f.prodError} operator={operator} action={f.prodAction} disabled={scenarioBusy} onStart={f.prodStart} onRollback={f.prodRollback} onReset={f.prodReset} />
          <Andon
            line={line}
            operator={operator}
            setOperator={setOperator}
            onStop={(by, reason) => f.pause(by, reason)}
            onResume={(by) => f.resume(by, '')}
          />
        </div>
        <AnimatePresence>
          {line.paused && (
            <motion.div className="hazard-sweep" initial={{ scaleX: 0 }} animate={{ scaleX: 1 }} exit={{ scaleX: 0, transformOrigin: 'right' }} transition={{ duration: 0.45, ease: [0.2, 0.8, 0.2, 1] }} />
          )}
        </AnimatePresence>
      </header>

      <div>
        {line.paused && (
          <div className="banner stopped" role="status">
            <b>Line stopped{line.by ? ` by ${line.by}` : ''}{line.ts ? ` at ${line.ts.slice(11, 19)} UTC` : ''}.</b>
            {line.reason && <span>“{line.reason}”</span>}
            <span>Runs in progress finish their current station, then go to the queue. New runs stop before scope.</span>
          </div>
        )}
        {f.error && source.kind === 'http' && f.errorStatus !== 401 && (
          <div className="banner error" role="alert">
            <b>Can't reach the factory{API_URL ? ` at ${API_URL}` : ''}.</b>
            <span>Start it with <code>.venv/bin/factory serve</code>, or open <a href="?source=mock" style={{ color: 'inherit' }}>?source=mock</a> to use simulated data.</span>
          </div>
        )}
        {launchError && <div className="banner error" role="alert"><b>Could not start every run.</b><span>{launchError}</span></div>}
        {launchNote && <div className="banner info" role="status">{launchNote}</div>}
      </div>

      <main className="main">
        <div className="left">
          <div>
            <JudgeGuide disabled={!f.meta || !f.bugs.length || f.visitSeq === null || f.prodAction !== null || scenarioBusy} paused={line.paused} onTry={tryScenario} />
            <div className="board-head">
              <h1 className="h-display">The line</h1>
              <span className="sub">{lanes.length ? `${lanes.length} run${lanes.length > 1 ? 's' : ''} · ${lanes.filter((r) => r.status === 'shipped').length} shipped · ${lanes.filter((r) => r.status === 'escalated').length} escalated${lanes.some((r) => r.status === 'closed') ? ` · ${lanes.filter((r) => r.status === 'closed').length} closed` : ''}` : 'No runs on the board'}</span>
              <span className="spacer" />
              <Launcher mode={mode} setMode={setMode} meta={f.meta} bugs={f.bugs} prod={f.prod} onRun={onRun} disabled={f.visitSeq === null || f.prodAction !== null || scenarioBusy} />
            </div>
            <div className="board-tools">
              {picked && <button type="button" className="btn small ghost" onClick={() => setPicked(null)}>Follow live</button>}
              {lanes.length > 0 && <button type="button" className="btn small ghost" onClick={() => { setClearedAt(f.state.lastSeq); setPicked(null) }}>Clear board</button>}
              {cutoff !== null && cutoff > 0 && <button type="button" className="btn small ghost" onClick={() => setClearedAt(0)}>Show earlier runs</button>}
            </div>
            {lanes.length ? (
              <Board runs={lanes} stations={stations} selected={selected} onSelect={setPicked} onOpen={setOpenRun} now={now} />
            ) : (
              <div className="empty-board">
                <b>The line is quiet</b>
                <span>Press <b style={{ font: 'inherit', textTransform: 'none' }}>Run all</b> to send every bug in the inbox through the {stations.length} stations. Each bug gets a lane, and each station lights up as the bug reaches it.</span>
                <span className="note">{mode === 'dev' ? 'Dev mode: reference fixer and dev reproducer, no model calls, about 2 s per bug.' : 'Live mode: Nemotron in every role, about 30 to 60 s per bug.'}</span>
              </div>
            )}
          </div>
          <Inspector run={selRun} station={selected?.station ?? null} onOpen={setOpenRun} />
        </div>
        <aside className="rail">
          <Queue runs={queue} acked={acked} onAck={(id) => setAcked([...acked, id])} onOpen={setOpenRun} />
          <EventStream events={f.events} broken={broken} />
        </aside>
      </main>

      <AnimatePresence>
        {drawerRun && (
          <RunDrawer key={drawerRun.runId} run={drawerRun} events={f.eventsByRun[drawerRun.runId] ?? []} source={source} onClose={() => setOpenRun(null)} />
        )}
      </AnimatePresence>
    </div>
  )
}
