import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useRef, useState } from 'react'
import type { LineState } from '../api/types'

const HOLD_MS = 1000

/**
 * The andon cord. Hold for a second to stop the line, so it can't be pulled by accident.
 * In factory/pipeline.py a stop is not a pause: every run escalates before its next station.
 */
export function Andon({ line, operator, setOperator, onStop, onResume }: {
  line: LineState
  operator: string
  setOperator: (v: string) => void
  onStop: (by: string, reason: string) => Promise<void>
  onResume: (by: string) => Promise<void>
}) {
  const btn = useRef<HTMLButtonElement>(null)
  const raf = useRef(0)
  const start = useRef(0)
  const [askReason, setAskReason] = useState(false)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)

  const setP = (p: number) => btn.current?.style.setProperty('--p', String(p))
  const cancel = () => { cancelAnimationFrame(raf.current); setP(0) }
  useEffect(() => cancel, [])

  const fire = async () => {
    cancel()
    setBusy(true)
    try {
      await onStop(operator || 'operator', '')
      setReason('')
      setAskReason(true)
    } finally {
      setBusy(false)
    }
  }
  const tick = () => {
    const p = Math.min(1, (performance.now() - start.current) / HOLD_MS)
    setP(p)
    if (p >= 1) void fire()
    else raf.current = requestAnimationFrame(tick)
  }
  const begin = () => {
    if (line.paused || busy) return
    start.current = performance.now()
    cancelAnimationFrame(raf.current)
    raf.current = requestAnimationFrame(tick)
  }

  if (line.paused) {
    return (
      <div className="rel">
        <button type="button" className="andon resume" disabled={busy} onClick={async () => { setBusy(true); try { await onResume(operator || 'operator') } finally { setBusy(false); setAskReason(false) } }}>
          <span>Resume line</span>
        </button>
        <AnimatePresence>
          {askReason && (
            <motion.form
              className="popover"
              initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }}
              onSubmit={async (e) => { e.preventDefault(); await onStop(operator || 'operator', reason.trim()); setAskReason(false) }}
            >
              <h4>Line stopped</h4>
              <p>Each run in progress finishes its current station, then goes to the queue. Add a reason for the record.</p>
              <label className="field" htmlFor="andon-reason">Reason (optional)
                <input id="andon-reason" autoFocus value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. suspicious diff on bug1" />
              </label>
              <label className="field" htmlFor="andon-by">Stopped by
                <input id="andon-by" value={operator} onChange={(e) => setOperator(e.target.value)} placeholder="operator" />
              </label>
              <div className="row">
                <button type="button" className="btn ghost" onClick={() => setAskReason(false)}>Skip</button>
                <button type="submit" className="btn primary">Save reason</button>
              </div>
            </motion.form>
          )}
        </AnimatePresence>
      </div>
    )
  }

  return (
    <button
      ref={btn}
      type="button"
      className="andon"
      disabled={busy}
      aria-label="Stop the line: press and hold for one second"
      title="Press and hold for one second"
      onPointerDown={begin}
      onPointerUp={cancel}
      onPointerLeave={cancel}
      onPointerCancel={cancel}
      onKeyDown={(e) => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); begin() } }}
      onKeyUp={cancel}
    >
      <span>Hold to stop line</span>
    </button>
  )
}
