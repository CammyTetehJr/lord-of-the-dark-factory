import { AnimatePresence, motion } from 'motion/react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { API_URL, ApiError } from './api/source'
import type { RunRequest } from './api/types'
import { Andon } from './components/Andon'
import { Board, type Selection } from './components/Board'
import { Inspector } from './components/Inspector'
import { buildRequest, Launcher, type Mode } from './components/Launcher'
import { JudgeGuide, type Scenario, type ScenarioStart } from './components/JudgeGuide'
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
  const [myRuns, setMyRuns] = useStored<string[]>('df.myRuns', [])
  const [guideOpen, setGuideOpen] = useStored('df.guide.open', true)
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
    let errorStatus: number | null = null
    const ids: string[] = []
    try {
      for (const r of reqs) {
        const res = await source.startRun(r)
        ids.push(res.run_id)
        started++
        if ((res.queued_behind ?? 0) > 0) waiting++
      }
    } catch (e) {
      // 429 carries the server's plain-language reason (line busy, hourly cap)
      errorStatus = e instanceof ApiError ? e.status : null
      error = started ? `${started} of ${reqs.length} started. ${(e as Error).message}` : (e as Error).message
      setLaunchError(error)
    }
    if (ids.length) setMyRuns([...new Set([...myRuns, ...ids])])
    // runs beyond the active limit wait their turn; they appear on the board when they start
    if (waiting) setLaunchNote(`${waiting} run${waiting > 1 ? 's are' : ' is'} waiting their turn and will appear on the line when ${waiting > 1 ? 'they start' : 'it starts'}.`)
    return { started, waiting, error, errorStatus, ids }
  }, [myRuns, setMyRuns])

  const tryScenario = async (scenario: Scenario): Promise<ScenarioStart> => {
    setScenarioBusy(true)
    try {
      if (f.line.paused) throw new Error('The line is paused by a human. Release the cord to run.')
      let note: string | undefined
      if (scenario === 'easy' || scenario === 'easy-all' || scenario === 'slow') {
        const prod = await source.prod()
        const bug = scenario === 'slow' ? 'bug1' : 'bug3'
        if (prod.mainline.some((line) => line.includes(`fix(${bug}):`))) {
          const reset = await f.prodReset(operator || 'judge')
          if (!reset.ok) throw new Error(`Not reset: ${reset.message}. No scenario runs were started.`)
          note = `Production contained fix(${bug}); reset to the original code before starting.`
        }
      }
      const reqs = scenario === 'easy' ? [buildRequest('live', 'bug3')]
        : scenario === 'easy-all' ? ['bug1', 'bug2', 'bug3', 'bug4', 'bug5'].map((id) => buildRequest('live', id))
        : scenario === 'nasty' ? ['bug6', 'bug7'].map((id) => buildRequest('live', id))
        : scenario === 'rogue' ? [buildRequest('dev', 'bug1', 'rogue:delete_test', 'branch'), buildRequest('live', 'bug3', 'rogue:game_test')]
        : [buildRequest('dev', 'bug1', 'rogue:slow_fix', 'canary')]
      const res = await onRun(reqs)
      if (res.error) throw new Error(res.errorStatus === 429 ? res.error : 'The factory is not reachable right now.')
      return { ids: res.ids, note }
    } finally { setScenarioBusy(false) }
  }

  const highlight = (control: 'andon' | 'rollback' | 'replay' | 'audit') => {
    const pulse = (selector: string) => {
      const element = document.querySelector(selector)
      if (!element) return
      element.classList.add('guide-pulse')
      setTimeout(() => element.classList.remove('guide-pulse'), 2_000)
    }
    if (control === 'replay') {
      const runId = [...myRuns].reverse().find((id) => f.state.runs[id]) ?? [...f.state.order].reverse().find((id) => f.state.runs[id])
      if (runId) {
        setOpenRun(runId)
        setTimeout(() => pulse('.drawer .replay-control'), 100)
      }
      return
    }
    pulse(control === 'andon' ? '.andon' : control === 'rollback' ? '.prod .kill' : '.audit-pill')
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
          {!guideOpen && <button type="button" className="btn small guide-open" onClick={() => setGuideOpen(true)}>Try it</button>}
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
              <Board runs={lanes} stations={stations} selected={selected} myRuns={myRuns} onSelect={setPicked} onOpen={setOpenRun} now={now} />
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
          <JudgeGuide open={guideOpen} setOpen={setGuideOpen} disabled={!f.meta || !f.bugs.length || f.visitSeq === null || f.prodAction !== null || scenarioBusy} paused={line.paused} runs={f.state.runs} onTry={tryScenario} onOpen={setOpenRun} onHighlight={highlight} />
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
