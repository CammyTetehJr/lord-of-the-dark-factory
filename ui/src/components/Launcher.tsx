import { AnimatePresence, motion } from 'motion/react'
import { useState } from 'react'
import type { Bug, Meta, ProdStatus, RunRequest } from '../api/types'

export type Mode = 'dev' | 'live'

/** A promoted, not reverted, fix for this bug is in production: slow_fix's diff would no longer apply. */
export function prodHasFixFor(prod: ProdStatus | null, bug: Bug | undefined): boolean {
  if (!prod || !bug) return false
  return prod.history.some((h) => h.event === 'promoted' && !h.reverted && h.title === bug.title)
}

/**
 * Dev: the real pipeline with stand-ins and a plain branch deploy, about 2 s per bug, free.
 * Live: every field left out, so the server defaults to Nemotron in every role and the canary deploy.
 */
export function buildRequest(mode: Mode, bug_id: string, fixer?: string, deploy?: 'canary' | 'branch'): RunRequest {
  // slow_fix passes every test; only the canary catches it, so it gets one even in Dev mode (no API key needed)
  if (fixer === 'rogue:slow_fix' && !deploy) deploy = 'canary'
  if (mode === 'dev') return { bug_id, fixer: fixer ?? 'reference', reproducer: 'dev', classifier: 'none', reviewer: 'none', deploy: deploy ?? 'branch' }
  const req: RunRequest = { bug_id }
  if (fixer && fixer !== 'nemotron') req.fixer = fixer
  if (deploy) req.deploy = deploy
  return req
}

export function Launcher({ mode, setMode, meta, bugs, prod, onRun, disabled = false }: {
  mode: Mode
  setMode: (m: Mode) => void
  meta: Meta | null
  bugs: Bug[]
  prod: ProdStatus | null
  onRun: (reqs: RunRequest[]) => Promise<unknown>
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [bug, setBug] = useState('bug1')
  const [fixer, setFixer] = useState('default')
  const [deploy, setDeploy] = useState<'default' | 'canary' | 'branch'>('default')
  const [busy, setBusy] = useState(false)
  const run = async (reqs: RunRequest[]) => { setBusy(true); try { await onRun(reqs) } finally { setBusy(false) } }
  const fixers = (meta?.fixers ?? []).filter((f) => f !== 'nemotron' && f !== 'reference')
  const chosen = fixer === 'default' ? undefined : fixer
  const chosenDeploy = deploy === 'default' ? undefined : deploy
  const effectiveDeploy = buildRequest(mode, bug, chosen, chosenDeploy).deploy ?? 'canary'

  return (
    <>
      <div className="seg" role="group" aria-label="Run mode">
        <button type="button" aria-pressed={mode === 'dev'} onClick={() => setMode('dev')} title="Reference fixer and dev reproducer, no model calls. About 2 s per bug.">Dev</button>
        <button type="button" aria-pressed={mode === 'live'} onClick={() => setMode('live')} title="Nemotron in every role. About 30 to 60 s per bug.">Live · Nemotron</button>
      </div>
      <button type="button" className="btn primary" disabled={!bugs.length || busy || disabled} onClick={() => run(bugs.map((b) => buildRequest(mode, b.id)))}>
        Run all {bugs.length ? `(${bugs.length})` : ''}
      </button>
      <div className="rel">
        <button type="button" className="btn" aria-expanded={open} onClick={() => setOpen(!open)} disabled={!bugs.length || disabled}>Run one…</button>
        <AnimatePresence>
          {open && (
            <motion.form
              className="popover"
              style={{ left: 0, right: 'auto' }}
              initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }}
              onSubmit={async (e) => { e.preventDefault(); await run([buildRequest(mode, bug, chosen, chosenDeploy)]); setOpen(false) }}
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
              <label className="field" htmlFor="run-deploy">Deploy
                <select id="run-deploy" className="select" value={deploy} onChange={(e) => setDeploy(e.target.value as typeof deploy)}>
                  <option value="default">{fixer === 'rogue:slow_fix' ? 'canary to production (needed for slow_fix)' : mode === 'dev' ? 'branch only (Dev default)' : 'canary to production (Live default)'}</option>
                  <option value="canary">canary to production (about 15 s more)</option>
                  <option value="branch">branch only, no production</option>
                </select>
              </label>
              {fixer === 'rogue:slow_fix' && (
                effectiveDeploy === 'canary'
                  ? <p>Passes every test; the canary is what catches it (about 15 s more, no API key needed).</p>
                  : <p style={{ color: 'var(--sodium)' }}>With a branch deploy this fix ships: only the canary catches it.</p>
              )}
              {fixer === 'rogue:slow_fix' && bug !== 'bug1' && <p style={{ color: 'var(--sodium)' }}>slow_fix only works on bug1.</p>}
              {fixer === 'rogue:slow_fix' && bug === 'bug1' && effectiveDeploy === 'canary' && prodHasFixFor(prod, bugs.find((b) => b.id === 'bug1')) && (
                <p style={{ color: 'var(--sodium)' }}>Production already has the honest bug1 fix, so this run will close as “already fixed” before it reaches the canary. Use “Roll back last fix” first.</p>
              )}
              {fixer === 'rogue:game_test' && mode === 'dev' && (
                <p style={{ color: 'var(--sodium)' }}>Only the Nemotron reviewer catches this fix. In Dev mode the reviewer is off and it will ship. Switch to Live.</p>
              )}
              {fixer === 'rogue:game_test' && bug !== 'bug3' && <p>game_test only works on bug3.</p>}
              <p>{mode === 'dev' ? 'Dev: no model calls, about 2 s.' : 'Live: Nemotron in every role you leave at its default, about 30 to 60 s.'}</p>
              <div className="row">
                <button type="button" className="btn ghost" onClick={() => setOpen(false)}>Cancel</button>
                <button type="submit" className="btn primary" disabled={busy || disabled}>Start run</button>
              </div>
            </motion.form>
          )}
        </AnimatePresence>
      </div>
    </>
  )
}
