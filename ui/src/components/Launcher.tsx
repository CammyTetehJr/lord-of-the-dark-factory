import { AnimatePresence, motion } from 'motion/react'
import { useState } from 'react'
import type { Bug, Meta, RunRequest } from '../api/types'

export type Mode = 'dev' | 'live'

/**
 * Dev: the real pipeline with stand-ins and a plain branch deploy, about 2 s per bug, free.
 * Live: every field left out, so the server defaults to Nemotron in every role and the canary deploy.
 */
export function buildRequest(mode: Mode, bug_id: string, fixer?: string): RunRequest {
  if (mode === 'dev') return { bug_id, fixer: fixer ?? 'reference', reproducer: 'dev', classifier: 'none', reviewer: 'none', deploy: 'branch' }
  return fixer && fixer !== 'nemotron' ? { bug_id, fixer } : { bug_id }
}

export function Launcher({ mode, setMode, meta, bugs, onRun }: {
  mode: Mode
  setMode: (m: Mode) => void
  meta: Meta | null
  bugs: Bug[]
  onRun: (reqs: RunRequest[]) => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [bug, setBug] = useState('bug1')
  const [fixer, setFixer] = useState('default')
  const [busy, setBusy] = useState(false)
  const run = async (reqs: RunRequest[]) => { setBusy(true); try { await onRun(reqs) } finally { setBusy(false) } }
  const fixers = (meta?.fixers ?? []).filter((f) => f !== 'nemotron' && f !== 'reference')
  const chosen = fixer === 'default' ? undefined : fixer

  return (
    <>
      <div className="seg" role="group" aria-label="Run mode">
        <button type="button" aria-pressed={mode === 'dev'} onClick={() => setMode('dev')} title="Reference fixer and dev reproducer, no model calls. About 2 s per bug.">Dev</button>
        <button type="button" aria-pressed={mode === 'live'} onClick={() => setMode('live')} title="Nemotron in every role. About 30 to 60 s per bug.">Live · Nemotron</button>
      </div>
      <button type="button" className="btn primary" disabled={!bugs.length || busy} onClick={() => run(bugs.map((b) => buildRequest(mode, b.id)))}>
        Run all {bugs.length ? `(${bugs.length})` : ''}
      </button>
      <div className="rel">
        <button type="button" className="btn" aria-expanded={open} onClick={() => setOpen(!open)} disabled={!bugs.length}>Run one…</button>
        <AnimatePresence>
          {open && (
            <motion.form
              className="popover"
              style={{ left: 0, right: 'auto' }}
              initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }}
              onSubmit={async (e) => { e.preventDefault(); await run([buildRequest(mode, bug, chosen)]); setOpen(false) }}
            >
              <h4>Run one bug</h4>
              <label className="field" htmlFor="run-bug">Bug
                <select id="run-bug" className="select" value={bug} onChange={(e) => setBug(e.target.value)}>
                  {bugs.map((b) => <option key={b.id} value={b.id}>{b.id}: {b.title}</option>)}
                </select>
              </label>
              <label className="field" htmlFor="run-fixer">Fixer
                <select id="run-fixer" className="select" value={fixer} onChange={(e) => setFixer(e.target.value)}>
                  <option value="default">{mode === 'dev' ? 'reference (dev stand-in)' : 'nemotron'}</option>
                  {fixers.map((f) => <option key={f} value={f}>{f}</option>)}
                </select>
              </label>
              {fixer === 'rogue:game_test' && mode === 'dev' && (
                <p style={{ color: 'var(--sodium)' }}>Only the Nemotron reviewer catches this fix. In Dev mode the reviewer is off and it will ship. Switch to Live.</p>
              )}
              {fixer === 'rogue:game_test' && bug !== 'bug3' && <p>game_test only works on bug3.</p>}
              <p>{mode === 'dev' ? 'Dev: no model calls, about 2 s.' : 'Live: Nemotron in every role you leave at its default, about 30 to 60 s.'}</p>
              <div className="row">
                <button type="button" className="btn ghost" onClick={() => setOpen(false)}>Cancel</button>
                <button type="submit" className="btn primary" disabled={busy}>Start run</button>
              </div>
            </motion.form>
          )}
        </AnimatePresence>
      </div>
    </>
  )
}
