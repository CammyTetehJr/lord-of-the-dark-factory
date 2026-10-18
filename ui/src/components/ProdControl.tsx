import { AnimatePresence, motion } from 'motion/react'
import { useState } from 'react'
import type { ProdHistoryEntry, ProdStatus } from '../api/types'

const EVENT_LABEL: Record<string, string> = {
  stable_started: 'stable started',
  promoted: 'fix promoted',
  rolled_back: 'canary rolled back',
  manual_rollback: 'rolled back by a human',
}

/** The most recent promoted fix that has not been reverted: what the kill switch would undo. */
export function lastPromoted(prod: ProdStatus | null): ProdHistoryEntry | undefined {
  return prod ? [...prod.history].reverse().find((h) => h.event === 'promoted' && !h.reverted) : undefined
}

const time = (ts: string) => ts.slice(11, 19)

/**
 * Production status and the human kill switch. One click opens the confirmation, which names
 * exactly which fix will be reverted; production restarts without it.
 */
export function ProdControl({ prod, error, operator, onStart, onRollback }: {
  prod: ProdStatus | null
  error: string | null
  operator: string
  onStart: () => Promise<void>
  onRollback: (by: string) => Promise<{ ok: boolean; message: string }>
}) {
  const [open, setOpen] = useState<'history' | 'confirm' | null>(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)
  const target = lastPromoted(prod)
  const short = prod?.stable?.commit.slice(0, 7)

  const rollback = async () => {
    setBusy(true)
    try {
      setResult(await onRollback(operator || 'operator'))
    } catch (e) {
      setResult({ ok: false, message: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }

  if (!prod) {
    return <span className="pill" title={error ?? 'Checking production'}><i />{error ? 'PROD UNKNOWN' : 'PROD …'}</span>
  }

  return (
    <div className="rel prod">
      {prod.up ? (
        <button type="button" className="pill ok" onClick={() => { setResult(null); setOpen(open === 'history' ? null : 'history') }} aria-expanded={open === 'history'} title="Production: what is running and what changed">
          <i />PROD {short}
        </button>
      ) : (
        <span className="pill bad"><i />PROD DOWN</span>
      )}
      {!prod.up && (
        <button type="button" className="btn small" disabled={busy} onClick={async () => { setBusy(true); try { await onStart() } finally { setBusy(false) } }}>
          {busy ? 'Starting…' : 'Start production'}
        </button>
      )}
      <button
        type="button"
        className="btn kill"
        disabled={!prod.up || !target}
        title={target ? `Revert ${target.commit?.slice(0, 7)} and restart production without it` : 'No promoted fix to roll back'}
        onClick={() => { setResult(null); setOpen(open === 'confirm' ? null : 'confirm') }}
        aria-expanded={open === 'confirm'}
      >
        Roll back last fix
      </button>

      <AnimatePresence>
        {open === 'confirm' && (
          <motion.div className="popover" initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }}>
            <h4>Kill switch</h4>
            {result ? (
              <>
                <p style={{ color: result.ok ? 'var(--pass-ink)' : 'var(--halt-ink)' }}>{result.ok ? `Done: ${result.message}. Production restarted without it.` : `Not rolled back: ${result.message}`}</p>
                <div className="row"><button type="button" className="btn" onClick={() => setOpen(null)}>Close</button></div>
              </>
            ) : target ? (
              <>
                <p>Revert the last fix that reached production and restart stable without it:</p>
                <div className="ev" style={{ padding: 10 }}>
                  <b className="mono" style={{ fontSize: 13 }}>{target.commit?.slice(0, 10)}</b>
                  <div style={{ fontSize: 14, marginTop: 2 }}>{target.title}</div>
                  <div className="note mono" style={{ fontSize: 11.5 }}>promoted at {time(target.ts)} UTC · {target.run_id}</div>
                </div>
                <p>Recorded as rolled back by <b style={{ color: 'var(--ink)' }}>{operator || 'operator'}</b>.</p>
                <div className="row">
                  <button type="button" className="btn ghost" onClick={() => setOpen(null)} disabled={busy}>Cancel</button>
                  <button type="button" className="btn danger" onClick={rollback} disabled={busy}>{busy ? 'Rolling back…' : 'Roll back now'}</button>
                </div>
              </>
            ) : (
              <p>No promoted fix to roll back.</p>
            )}
          </motion.div>
        )}
        {open === 'history' && (
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
            <div className="row"><button type="button" className="btn ghost small" onClick={() => setOpen(null)}>Close</button></div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
