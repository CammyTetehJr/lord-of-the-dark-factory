import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useRef, useState } from 'react'
import type { FactoryEvent } from '../api/types'
import { stationInfo } from '../lib/stations'
import type { RunState } from '../state/reducer'

/**
 * The human queue. Built from the event stream, so it updates live and matches runs/escalations.jsonl.
 * The server has no acknowledged state yet, so acknowledging is kept per browser.
 */
export function Queue({ runs, acked, onAck, onOpen }: {
  runs: RunState[]
  acked: string[]
  onAck: (runId: string) => void
  onOpen: (runId: string) => void
}) {
  const [showAcked, setShowAcked] = useState(false)
  const open = runs.filter((r) => !acked.includes(r.runId))
  const done = runs.filter((r) => acked.includes(r.runId))
  const list = showAcked ? done : open
  return (
    <section aria-label="Escalation queue">
      <div className="rail-h">
        <div>
          <div className="eyebrow">Escalation queue</div>
          <div className="note">{showAcked ? 'Acknowledged on this screen' : 'Waiting on a human'}</div>
        </div>
        <div className="chips" style={{ alignItems: 'center' }}>
          {done.length > 0 && (
            <button type="button" className="btn small ghost" onClick={() => setShowAcked(!showAcked)}>
              {showAcked ? 'Show open' : `Acknowledged (${done.length})`}
            </button>
          )}
          <span className={`count ${open.length ? '' : 'zero'}`}>{open.length}</span>
        </div>
      </div>
      <div className="scroll">
        {list.length === 0 ? (
          <div className="q-empty">{showAcked ? 'Nothing acknowledged yet.' : 'Nothing waiting on a human. Escalated runs appear here with the reason they stopped.'}</div>
        ) : (
          <ul className="q">
            <AnimatePresence initial={false}>
              {list.map((r) => (
                <motion.li key={r.runId} layout initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.35, ease: [0.2, 0.8, 0.2, 1] }}>
                  <div className={`qi ${r.escalation?.held ? 'held' : ''}`} role="button" tabIndex={0} onClick={() => onOpen(r.runId)} onKeyDown={(e) => { if (e.key === 'Enter') onOpen(r.runId) }}>
                    <div className="top">
                      <b>{r.bug.id}</b>
                      <span className="chip">{r.fixer}</span>
                      <span className="st">{r.crash ? 'factory' : r.escalation ? (r.escalation.held ? 'andon · ' : '') + stationInfo(r.escalation.station).label : ''}</span>
                    </div>
                    <p>{r.crash ?? r.escalation?.reason}</p>
                    {!showAcked && (
                      <button type="button" className="btn small ghost ack" onClick={(e) => { e.stopPropagation(); onAck(r.runId) }}>Acknowledge</button>
                    )}
                  </div>
                </motion.li>
              ))}
            </AnimatePresence>
          </ul>
        )}
      </div>
    </section>
  )
}

function describe(e: FactoryEvent) {
  switch (e.type) {
    case 'run_started': return <>run_started · {e.bug.id} · {e.fixer}</>
    case 'station_started': return <>▸ {e.station}</>
    case 'station_finished': return <>■ {e.station} <span className={`o-${e.outcome}`}>{e.outcome}</span></>
    case 'escalated': return <>escalated · {e.station}</>
    case 'run_finished': return <>run_finished · {e.outcome}</>
    default: return (e as { type: string }).type
  }
}

export function EventStream({ events, broken }: { events: FactoryEvent[]; broken: number | null }) {
  const recent = events.slice(-120).reverse()
  const list = useRef<HTMLUListElement>(null)
  useEffect(() => {
    if (broken != null) list.current?.querySelector('.broken')?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [broken])
  return (
    <section aria-label="Event stream">
      <div className="rail-h">
        <div>
          <div className="eyebrow">Event stream</div>
          <div className="note">Hash-chained and signed, newest first</div>
        </div>
        <span className="mono note tnum">{events.length ? `seq ${events[events.length - 1].seq}` : ''}</span>
      </div>
      <div className="scroll">
        {recent.length === 0 ? (
          <div className="q-empty">No events yet. Start a run and every step will appear here as it is written.</div>
        ) : (
          <ul className="ticker" ref={list}>
            {recent.map((e) => (
              <li key={e.seq} className={broken === e.seq ? 'broken' : ''} title={`${e.run_id}\nhash ${e.hash}\nprev ${e.prev_hash}${e.key_id ? `\nsigned by ${e.key_id}` : ''}`}>
                <span>{e.seq}</span>
                <span className="ty">{describe(e)}</span>
                <span className="hs">…{e.hash.slice(-6)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}
