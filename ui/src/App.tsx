import { AnimatePresence, motion } from 'motion/react'
import { useCallback, useMemo, useState } from 'react'
import { API_URL } from './api/source'
import type { RunRequest } from './api/types'
import { Andon } from './components/Andon'
import { Board, type Selection } from './components/Board'
import { Inspector } from './components/Inspector'
import { Launcher, type Mode } from './components/Launcher'
import { EventStream, Queue } from './components/Rail'
import { RunDrawer } from './components/RunDrawer'
import { brokenSeq, pickSource, useFactory, useNow, useStored } from './hooks/useFactory'
import { escalatedRuns, type RunState } from './state/reducer'

const source = pickSource()
const DEFAULT_STATIONS = ['scope', 'baseline', 'reproduce', 'fix', 'oracle', 'diff_inspection', 'review', 'deploy']
const MAX_LANES = 12

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
  const [clearedAt, setClearedAt] = useStored('df.clearedAt', 0)
  const [picked, setPicked] = useState<Selection | null>(null)
  const [openRun, setOpenRun] = useState<string | null>(null)
  const [launchError, setLaunchError] = useState<string | null>(null)

  const stations = f.meta?.stations ?? DEFAULT_STATIONS
  const lanes = useMemo(
    () => f.state.order.map((id) => f.state.runs[id]).filter((r) => r.firstSeq > clearedAt).slice(-MAX_LANES),
    [f.state, clearedAt],
  )
  const anyRunning = lanes.some((r) => r.status === 'running')
  const now = useNow(anyRunning)
  const selected = picked && f.state.runs[picked.runId] ? picked : autoSelect(lanes)
  const selRun = selected ? f.state.runs[selected.runId] : null
  const queue = useMemo(() => escalatedRuns(f.state), [f.state])
  const broken = brokenSeq(f.audit)

  const onRun = useCallback(async (reqs: RunRequest[]) => {
    setLaunchError(null)
    try {
      for (const r of reqs) await source.startRun(r)
    } catch (e) {
      setLaunchError((e as Error).message)
    }
  }, [])

  const drawerRun = openRun ? f.state.runs[openRun] : null
  const line = f.line

  return (
    <div className="app">
      <header className="gbar" style={{ position: 'sticky' }}>
        <div className="brand">Dark Factory<small>{source.kind === 'mock' ? 'MOCK DATA' : 'CONTROL ROOM'}</small></div>
        <span className={`pill ${line.paused ? 'stopped' : 'ok'}`} role="status">
          <i />{line.paused ? 'LINE STOPPED' : 'LINE RUNNING'}
        </span>
        <span className={`pill audit-pill ${f.audit ? (f.audit.ok ? 'ok' : 'bad') : ''}`} title={f.audit?.message ?? 'Checking the audit chain'} role="status">
          <i />{f.audit ? `${f.audit.ok ? '✓' : '✗'} ${f.audit.message}` : 'checking chain…'}
        </span>
        {f.stream !== 'open' && <span className="pill warn"><i />{f.stream === 'connecting' ? 'connecting…' : 'reconnecting…'}</span>}
        <span className="spacer" />
        <Launcher mode={mode} setMode={setMode} meta={f.meta} bugs={f.bugs} onRun={onRun} />
        <Andon
          line={line}
          operator={operator}
          setOperator={setOperator}
          onStop={(by, reason) => f.pause(by, reason)}
          onResume={(by) => f.resume(by, '')}
        />
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
        {f.error && source.kind === 'http' && (
          <div className="banner error" role="alert">
            <b>Can't reach the factory at {API_URL}.</b>
            <span>Start it with <code>.venv/bin/factory serve</code>, or open <a href="?source=mock" style={{ color: 'inherit' }}>?source=mock</a> to use simulated data.</span>
          </div>
        )}
        {launchError && <div className="banner error" role="alert"><b>Could not start the run.</b><span>{launchError}</span></div>}
      </div>

      <main className="main">
        <div className="left">
          <div>
            <div className="board-head">
              <h1 className="h-display">The line</h1>
              <span className="sub">{lanes.length ? `${lanes.length} run${lanes.length > 1 ? 's' : ''} · ${lanes.filter((r) => r.status === 'shipped').length} shipped · ${lanes.filter((r) => r.status === 'escalated').length} escalated` : 'No runs on the board'}</span>
              <span className="spacer" />
              {picked && <button type="button" className="btn small ghost" onClick={() => setPicked(null)}>Follow live</button>}
              {lanes.length > 0 && <button type="button" className="btn small ghost" onClick={() => { setClearedAt(f.state.lastSeq); setPicked(null) }}>Clear board</button>}
              {clearedAt > 0 && <button type="button" className="btn small ghost" onClick={() => setClearedAt(0)}>Show earlier runs</button>}
            </div>
            {lanes.length ? (
              <Board runs={lanes} stations={stations} selected={selected} onSelect={setPicked} onOpen={setOpenRun} now={now} />
            ) : (
              <div className="empty-board">
                <b>The line is quiet</b>
                <span>Press <b style={{ font: 'inherit', textTransform: 'none' }}>Run all</b> to send every bug in the inbox through the {stations.length} stations. Each bug gets a lane, and each station lights up as the bug reaches it.</span>
                <span className="note">{mode === 'dev' ? 'Dev mode: reference fixer and dev reproducer, no model calls, about 2 s per bug.' : 'Live mode: Nemotron in every role, about 30 to 60 s per bug.'}</span>
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
