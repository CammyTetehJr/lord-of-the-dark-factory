import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { mockSource } from '../api/mock'
import { httpSource, type FactorySource, type StreamStatus } from '../api/source'
import type { AuditResult, Bug, FactoryEvent, LineState, Meta, ProdStatus } from '../api/types'
import { apply, emptyState, type FactoryState } from '../state/reducer'

export function pickSource(): FactorySource {
  const q = new URLSearchParams(location.search).get('source')
  const env = import.meta.env.VITE_SOURCE as string | undefined
  return (q ?? env) === 'mock' ? mockSource : httpSource
}

type Action = { kind: 'event'; e: FactoryEvent } | { kind: 'reset' }

function reducer(s: { state: FactoryState; events: FactoryEvent[] }, a: Action) {
  if (a.kind === 'reset') return { state: emptyState, events: [] }
  const next = apply(s.state, a.e)
  return next === s.state ? s : { state: next, events: [...s.events, a.e] }
}

/** "line 214: content was modified" → 214. Global log line n is seq n. */
export function brokenSeq(audit: AuditResult | null): number | null {
  if (!audit || audit.ok) return null
  const m = /line (\d+)/.exec(audit.message)
  return m ? Number(m[1]) : null
}

export function useFactory(source: FactorySource) {
  const [{ state, events }, dispatch] = useReducer(reducer, { state: emptyState, events: [] })
  const [stream, setStream] = useState<StreamStatus>('connecting')
  const [meta, setMeta] = useState<Meta | null>(null)
  const [bugs, setBugs] = useState<Bug[]>([])
  const [line, setLine] = useState<LineState>({ paused: false })
  const [audit, setAudit] = useState<AuditResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [errorStatus, setErrorStatus] = useState<number | null>(null)
  const [prod, setProd] = useState<ProdStatus | null>(null)
  const [prodError, setProdError] = useState<string | null>(null)
  const auditTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const refreshProd = useCallback(() => {
    source.prod().then((p) => { setProd(p); setProdError(null) }, (e: Error) => { setProd(null); setProdError(e.message) })
  }, [source])

  const refreshAudit = useCallback(() => {
    // If the server can't answer, drop back to "checking": never show green we can't currently back up.
    source.verify().then(setAudit, () => setAudit(null))
  }, [source])

  // meta + inbox once; retry until the server is up
  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setTimeout>
    const load = () =>
      Promise.all([source.meta(), source.bugs()]).then(
        ([m, b]) => { if (alive) { setMeta(m); setBugs(b); setError(null); setErrorStatus(null) } },
        (err: Error & { status?: number }) => { if (alive) { setError(err.message); setErrorStatus(err.status ?? null); timer = setTimeout(load, 3000) } },
      )
    load()
    return () => { alive = false; clearTimeout(timer) }
  }, [source])

  // live feed; re-verify the chain shortly after every finished run
  useEffect(() => {
    dispatch({ kind: 'reset' })
    return source.subscribe(0, (e) => {
      dispatch({ kind: 'event', e })
      if (e.type === 'run_finished') {
        clearTimeout(auditTimer.current)
        auditTimer.current = setTimeout(refreshAudit, 400)
      }
      // a promoted or rolled-back canary changes production
      if (e.type === 'deploy_progress' && (e.phase === 'promoted' || e.phase === 'rolled_back')) refreshProd()
    }, setStream)
  }, [source, refreshAudit, refreshProd])

  // the andon state has no event of its own, so poll it; audit is polled to catch edits to the file
  useEffect(() => {
    const tick = () => source.line().then(setLine, () => {})
    tick()
    refreshAudit()
    refreshProd()
    const a = setInterval(tick, 2000)
    const b = setInterval(refreshAudit, 5000)
    const c = setInterval(refreshProd, 4000)
    return () => { clearInterval(a); clearInterval(b); clearInterval(c) }
  }, [source, refreshAudit, refreshProd])

  const prodStart = useCallback(async () => { await source.prodStart(); refreshProd() }, [source, refreshProd])
  const prodReset = useCallback(async (by: string) => {
    const r = await source.prodReset(by)
    refreshProd()
    return r
  }, [source, refreshProd])
  const prodRollback = useCallback(async (by: string) => {
    const r = await source.prodRollback(by)
    refreshProd()
    return r
  }, [source, refreshProd])
  const pause = useCallback(async (by: string, reason: string) => setLine(await source.pause(by, reason)), [source])
  const resume = useCallback(async (by: string, reason: string) => setLine(await source.resume(by, reason)), [source])

  const eventsByRun = useMemo(() => {
    const m: Record<string, FactoryEvent[]> = {}
    for (const e of events) (m[e.run_id] ??= []).push(e)
    return m
  }, [events])

  return { state, events, eventsByRun, stream, meta, bugs, line, audit, error, errorStatus, pause, resume, refreshAudit, prod, prodError, prodStart, prodRollback, prodReset }
}

export function useNow(active: boolean, ms = 200): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const t = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(t)
  }, [active, ms])
  return now
}

export function useStored<T>(key: string, initial: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key)
      return raw ? (JSON.parse(raw) as T) : initial
    } catch {
      return initial
    }
  })
  const set = useCallback((next: T) => {
    setV(next)
    try { localStorage.setItem(key, JSON.stringify(next)) } catch { /* private mode */ }
  }, [key])
  return [v, set]
}
