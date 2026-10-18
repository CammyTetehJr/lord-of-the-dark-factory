import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useState } from 'react'
import type { ProdHistoryEntry, ProdStatus } from '../api/types'
import type { ProdAction } from '../hooks/useFactory'
import { HoldButton } from './HoldButton'

const EVENT_LABEL: Record<string, string> = {
  stable_started: 'stable started',
  promoted: 'fix promoted',
  rolled_back: 'canary rolled back',
  manual_rollback: 'rolled back by a human',
  reset: 'reset to the original code',
}

/** The most recent promoted fix that has not been reverted: what the kill switch would undo. */
export function lastPromoted(prod: ProdStatus | null): ProdHistoryEntry | undefined {
  return prod ? [...prod.history].reverse().find((h) => h.event === 'promoted' && !h.reverted) : undefined
}

const time = (ts: string) => ts.slice(11, 19)

/**
 * Production changes need a deliberate hold; progress is shared with guided scenarios.
 */
export function ProdControl({ prod, error, operator, action, disabled = false, onStart, onRollback, onReset }: {
  prod: ProdStatus | null
  error: string | null
  operator: string
  action: ProdAction | null
  disabled?: boolean
  onStart: () => Promise<void>
  onRollback: (by: string) => Promise<{ ok: boolean; message: string }>
  onReset: (by: string) => Promise<{ ok: boolean; message: string }>
}) {
  const [open, setOpen] = useState<'history' | null>(null)
  const busy = action !== null || disabled
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)
  const target = lastPromoted(prod)
  const short = prod?.stable?.commit.slice(0, 7)

  const change = async (kind: ProdAction) => {
    setOpen(null)
    setResult(null)
    try {
      if (kind === 'start') {
        await onStart()
        setResult({ ok: true, message: 'Production started.' })
      } else {
        const r = await (kind === 'reset' ? onReset : onRollback)(operator || 'judge')
        setResult({ ok: r.ok, message: kind === 'reset'
          ? r.ok ? 'Production reset. All seeded bugs are back.' : `Not reset: ${r.message}`
          : r.ok ? `Rolled back: ${r.message}. Production restarted without it.` : `Not rolled back: ${r.message}` })
      }
    } catch (e) {
      setResult({ ok: false, message: `${kind === 'reset' ? 'Not reset' : kind === 'rollback' ? 'Not rolled back' : 'Not started'}: ${(e as Error).message}` })
    }
  }

  // the result shows for a few seconds, then gets out of the way
  useEffect(() => {
    if (!result) return
    const t = setTimeout(() => setResult(null), 9000)
    return () => clearTimeout(t)
  }, [result])

  return (
    <div className="rel prod">
      {!prod ? <span className="pill" title={error ?? 'Checking production'}><i />{error ? 'PROD UNKNOWN' : 'PROD …'}</span> : prod.up ? (
        <button type="button" className="pill ok" onClick={() => { setResult(null); setOpen(open === 'history' ? null : 'history') }} aria-expanded={open === 'history'} title="Production: what is running and what changed">
          <i />PROD {short}
        </button>
      ) : (
        <span className="pill bad"><i />PROD DOWN</span>
      )}
      {prod && !prod.up && (
        <button type="button" className="btn small" disabled={busy} onClick={() => change('start')}>
          {action === 'start' ? 'Starting…' : 'Start production'}
        </button>
      )}
      <HoldButton
        className="kill"
        disabled={!prod?.up || !target || busy}
        onConfirm={() => change('rollback')}
        title={target ? `Hold for one second to revert ${target.commit?.slice(0, 7)} (${target.title}) and restart production without it` : 'No promoted fix to roll back'}
        label={target ? `Hold to roll back ${target.title}` : 'Hold to roll back: nothing promoted'}
      >
        <span className="hold-top">{action === 'rollback' ? 'Rolling back…' : 'Hold to roll back'}</span>
        <span className="hold-sub">{target ? target.title : 'nothing promoted'}</span>
      </HoldButton>
      <HoldButton
        className="reset"
        disabled={!prod || busy}
        onConfirm={() => change('reset')}
        title="Hold for one second to remove every promoted fix and restart production from the original code"
        label="Hold to reset production: all seeded bugs return"
      >
        <span className="hold-top">{action === 'reset' ? 'Resetting…' : 'Hold to reset'}</span>
        <span className="hold-sub">{action === 'reset' ? 'usually 5–10 s' : 'all bugs return'}</span>
      </HoldButton>

      <AnimatePresence>
        {(action || result) && (
          <motion.div className="popover toast" role={result && !result.ok && !action ? 'alert' : 'status'} initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }}>
            <p style={{ color: action ? 'var(--sodium)' : result?.ok ? 'var(--pass-ink)' : 'var(--halt-ink)' }}>
              {action === 'reset' ? 'Resetting production… Usually 5–10 seconds. Waiting for any deployment to finish first.' : action === 'rollback' ? 'Rolling back the last fix…' : action === 'start' ? 'Starting production…' : result?.message}
            </p>
          </motion.div>
        )}
        {open === 'history' && prod && !action && (
          <motion.div className="popover wide" initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }}>
            <h4>Production</h4>
            <p className="mono" style={{ fontSize: 12 }}>stable {prod.stable?.commit.slice(0, 10)} · {prod.url}</p>
            <div className="eyebrow">Mainline, newest first</div>
            <ul className="plist">
              {prod.mainline.map((c, i) => {
                const [sha, ...msg] = c.split(' ')
                return <li key={i} className={i === 0 ? 'cur' : ''}><span className="mono">{sha}</span> {msg.join(' ')}</li>
              })}
            </ul>
            <div className="eyebrow">History</div>
            <ul className="plist">
              {[...prod.history].reverse().slice(0, 8).map((h, i) => (
                <li key={i} className={`h-${h.event}`}>
                  <span className="mono">{time(h.ts)}</span> {EVENT_LABEL[h.event] ?? h.event}
                  {h.title && <> · {h.title}</>}
                  {h.by && <> · by {h.by}</>}
                  {h.reverted === true && <span className="chip" style={{ marginLeft: 6 }}>reverted</span>}
                  {h.reason && <div className="note">{h.reason}</div>}
                </li>
              ))}
            </ul>
            <div className="row">
              <button type="button" className="btn ghost small" onClick={() => setOpen(null)}>Close</button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
