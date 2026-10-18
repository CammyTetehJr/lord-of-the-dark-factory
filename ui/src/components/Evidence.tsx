import { motion } from 'motion/react'
import type { Evidence, ModelCall } from '../api/types'
import { shortModel } from '../lib/stations'
import type { StationState } from '../state/reducer'

export function Runs({ runs }: { runs: string[] }) {
  return (
    <span className="runs" aria-label={runs.join(', ')}>
      {runs.map((r, i) => (
        <motion.i key={i} className={r} title={r} initial={{ opacity: 0, x: -4 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.08 }} />
      ))}
    </span>
  )
}

export function Call({ call, label }: { call: ModelCall; label?: string }) {
  return (
    <div className="call">
      ◆ {label ? `${label} · ` : ''}{shortModel(call.model)}
      {call.prompt_tokens != null && <> · {call.prompt_tokens.toLocaleString()} in / {call.completion_tokens?.toLocaleString()} out</>}
      {call.seconds != null && <> · {call.seconds}s</>}
      {call.prompt_sha256 && <span className="h"> · prompt {call.prompt_sha256.slice(0, 12)}</span>}
    </div>
  )
}

export function DiffView({ diff }: { diff: string }) {
  return (
    <pre className="code">
      {diff.split('\n').map((l, i) => {
        const cls = l.startsWith('+++') || l.startsWith('---') || l.startsWith('diff ') || l.startsWith('@@') ? 'hh'
          : l.startsWith('+') ? 'a' : l.startsWith('-') ? 'r' : undefined
        return <span key={i} className={cls}>{l + '\n'}</span>
      })}
    </pre>
  )
}

const isCall = (x: unknown): x is ModelCall & Evidence => typeof x === 'object' && x !== null && 'model' in x

function Scope({ ev }: { ev: Evidence }) {
  // older runs put matches at the top level; newer ones under rules
  const matches: Record<string, string[]> = ev.rules?.matches ?? ev.matches ?? {}
  const entries = Object.entries(matches)
  const clf = ev.classifier
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <div>
        <div className="eyebrow">Keyword rules</div>
        {entries.length ? entries.map(([area, words]) => (
          <div className="chips" key={area} style={{ marginTop: 4 }}>
            <span className="chip hit">{area}</span>
            {words.map((w) => <span className="chip" key={w}>“{w}”</span>)}
          </div>
        )) : <div className="chips" style={{ marginTop: 4 }}><span className="chip ok">no protected area matched</span></div>}
      </div>
      <div>
        <div className="eyebrow">Classifier</div>
        {clf === 'disabled' && <div className="note">Disabled for this run.</div>}
        {clf == null && <div className="note">Not consulted: a rule already escalated.</div>}
        {clf && typeof clf === 'object' && Array.isArray(clf.votes) && (
          <>
            <div className="chips" style={{ marginTop: 4, alignItems: 'center' }}>
              <span className={`chip ${clf.trivial_votes >= clf.needed ? 'ok' : 'hit'}`}>{clf.trivial_votes}/{clf.votes.length} votes say trivial</span>
              <span className="note">needs {clf.needed}</span>
            </div>
            {clf.votes.map((v: Evidence, i: number) => (
              <div key={i} className="cand">
                <div className="chips" style={{ marginTop: 6 }}>
                  <span className="chip">vote {i + 1}</span>
                  {v.answer && typeof v.answer === 'object' ? (
                    <>
                      <span className={`chip ${v.answer.trivial ? 'ok' : 'hit'}`}>{v.answer.trivial ? 'trivial' : 'not trivial'}</span>
                      {v.answer.category && <span className="chip">{v.answer.category}</span>}
                      {v.answer.confidence != null && <span className="chip">confidence {Number(v.answer.confidence).toFixed(2)}</span>}
                    </>
                  ) : <span className="chip hit">{v.error ? 'failed' : 'unreadable'}</span>}
                </div>
                {v.answer?.reason && <div className="note" style={{ marginTop: 4 }}>{v.answer.reason}</div>}
                {v.error && <div className="note" style={{ marginTop: 4 }}>{v.error}</div>}
                {isCall(v) && <Call call={v} label={`vote ${i + 1}`} />}
              </div>
            ))}
          </>
        )}
        {isCall(clf) && !Array.isArray(clf.votes) && (
          <>
            {clf.answer && typeof clf.answer === 'object' && (
              <div className="chips" style={{ marginTop: 4 }}>
                <span className={`chip ${clf.answer.trivial ? 'ok' : 'hit'}`}>{clf.answer.trivial ? 'trivial' : 'not trivial'}</span>
                {clf.answer.category && <span className="chip">{clf.answer.category}</span>}
                {clf.answer.confidence != null && <span className="chip">confidence {Number(clf.answer.confidence).toFixed(2)}</span>}
              </div>
            )}
            {clf.answer?.reason && <div className="note" style={{ marginTop: 4 }}>{clf.answer.reason}</div>}
            <Call call={clf} label="classifier" />
          </>
        )}
        {clf && typeof clf === 'object' && 'error' in clf && <div className="note">Classifier error: {clf.error}</div>}
      </div>
    </div>
  )
}

function Reproduce({ ev }: { ev: Evidence }) {
  const attempts: Evidence[] = ev.attempts ?? []
  if (!attempts.length) return <div className="note">The reproducer produced no candidate tests.</div>
  return (
    <div>
      {attempts.map((a) => (
        <div className="cand" key={a.candidate}>
          <div className="chips" style={{ alignItems: 'center' }}>
            <span className={`chip ${a.qualified ? 'ok' : 'hit'}`}>candidate {a.candidate} · {a.qualified ? 'qualified' : 'rejected'}</span>
            {a.runs?.length > 0 && <Runs runs={a.runs} />}
          </div>
          <div className="note" style={{ marginTop: 4 }}>{a.reason}</div>
          {isCall(a.generator) && <Call call={a.generator} label="generator" />}
          {a.generator?.source && <div className="note mono" style={{ fontSize: 12 }}>dev stand-in: {a.generator.source}</div>}
        </div>
      ))}
    </div>
  )
}

function Fix({ ev, compact }: { ev: Evidence; compact?: boolean }) {
  const attempts: Evidence[] = ev.fixer_meta?.attempts ?? []
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <div className="blackbox">
        <div className="stamp">Black box</div>
        <dl className="kv" style={{ marginTop: 8 }}>
          <dt>fixer</dt><dd>{ev.fixer}</dd>
          {ev.seconds != null && <><dt>inside</dt><dd className="tnum">{ev.seconds}s</dd></>}
          {ev.diff_sha256 && <><dt>diff sha256</dt><dd className="mono">{String(ev.diff_sha256).slice(0, 16)}…</dd></>}
        </dl>
        {attempts.map((a) => (
          <div key={a.attempt}>
            <Call call={a as ModelCall} label={`attempt ${a.attempt}`} />
            <div className="note" style={{ paddingLeft: 12 }}>{a.result}</div>
          </div>
        ))}
      </div>
      {ev.traceback && <pre className="code">{ev.traceback}</pre>}
      {ev.diff && !compact && <DiffView diff={ev.diff} />}
      {ev.diff && compact && <div className="note">Diff returned ({String(ev.diff).split('\n').length} lines). Open the run for the full diff.</div>}
    </div>
  )
}

function Oracle({ ev }: { ev: Evidence }) {
  if (ev.git_apply) return <pre className="code">{ev.git_apply}</pre>
  const counts = ev.suite?.attempts?.[0]?.counts ?? {}
  return (
    <dl className="kv">
      <dt>repro test</dt><dd><Runs runs={ev.repro_test?.runs ?? []} /></dd>
      <dt>suite</dt><dd className="tnum">{Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ') || '—'}</dd>
      <dt>flaky</dt><dd>{ev.suite?.flaky ? 'yes' : 'no'}</dd>
    </dl>
  )
}

function DiffChecks({ ev }: { ev: Evidence }) {
  const checks: { check: string; ok: boolean; detail: string }[] = [...(ev.checks ?? [])].sort((a, b) => Number(a.ok) - Number(b.ok))
  return (
    <>
      <ul className="checks">
        {checks.map((c, i) => (
          <motion.li layout key={c.check} className={c.ok ? '' : 'bad'} initial={{ opacity: 0, x: -4 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.04 }}>
            <span className="m">{c.ok ? '✓' : '✗'}</span>
            <span>{c.check}<span className="d">{c.detail}</span></span>
          </motion.li>
        ))}
      </ul>
      {ev.files && <div className="note" style={{ marginTop: 8 }}>{ev.files.join(', ')} · {ev.lines_changed} line(s)</div>}
    </>
  )
}

function Review({ ev }: { ev: Evidence }) {
  if (ev.reviewer === 'disabled') return <div className="note">Model reviewer disabled for this run. Only the deterministic checks judged this fix.</div>
  const a = ev.answer
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      {a && typeof a === 'object' && (
        <>
          <div className={`verdict ${a.verdict}`}>{a.verdict}{a.confidence != null && <span className="note mono">confidence {Number(a.confidence).toFixed(2)}</span>}</div>
          {a.concerns?.length > 0 && <div className="chips">{a.concerns.map((c: string) => <span className="chip hit" key={c}>{c}</span>)}</div>}
          {a.reason && <div className="note">{a.reason}</div>}
        </>
      )}
      {ev.error && <div className="note">Reviewer error: {ev.error}</div>}
      {isCall(ev) && <Call call={ev} label="reviewer" />}
    </div>
  )
}

function Deploy({ ev }: { ev: Evidence }) {
  return (
    <dl className="kv">
      <dt>mode</dt><dd><span className="chip">{ev.mode === 'branch' ? 'branch only, no production deploy' : ev.mode ?? 'branch'}</span></dd>
      {ev.branch && <><dt>branch</dt><dd className="mono">{ev.branch}</dd></>}
      {ev.commit && <><dt>commit</dt><dd className="mono">{String(ev.commit).slice(0, 10)}</dd></>}
      {ev.release_suite && <><dt>release suite</dt><dd className="tnum">{Object.entries(ev.release_suite.counts ?? {}).map(([k, v]) => `${v} ${k}`).join(', ')}</dd></>}
      {ev.git && <><dt>git</dt><dd className="mono">{ev.git}</dd></>}
    </dl>
  )
}

function Held({ ev }: { ev: Evidence }) {
  return (
    <dl className="kv">
      <dt>stopped by</dt><dd>{ev.line?.by ?? 'operator'}</dd>
      <dt>reason</dt><dd>{ev.line?.reason || 'none given'}</dd>
      <dt>at</dt><dd className="mono">{ev.line?.ts}</dd>
    </dl>
  )
}

export function StationEvidence({ station, st, compact }: { station: string; st: StationState; compact?: boolean }) {
  const ev = st.evidence
  if (!ev) {
    if (st.status === 'running') return <div className="note">Running. Nothing is reported until the station finishes.</div>
    if (st.status === 'skipped') return <div className="note">Not reached. An earlier station stopped this run.</div>
    return <div className="note">Waiting.</div>
  }
  if (st.status === 'held') return <Held ev={ev} />
  switch (station) {
    case 'scope': return <Scope ev={ev} />
    case 'baseline': return <dl className="kv"><dt>tests</dt><dd className="tnum">{Object.entries(ev.tests?.counts ?? {}).map(([k, v]) => `${v} ${k}`).join(', ')}</dd>{ev.commit && <><dt>commit</dt><dd className="mono">{String(ev.commit).slice(0, 10)}</dd></>}</dl>
    case 'reproduce': return <Reproduce ev={ev} />
    case 'fix': return <Fix ev={ev} compact={compact} />
    case 'oracle': return <Oracle ev={ev} />
    case 'diff_inspection': return <DiffChecks ev={ev} />
    case 'review': return <Review ev={ev} />
    case 'deploy': return <Deploy ev={ev} />
    default: return <pre className="code">{JSON.stringify(ev, null, 2)}</pre>
  }
}

/** Every model call recorded in a run, for the run detail. */
export function modelCalls(byStation: Record<string, StationState>): { station: string; role: string; call: ModelCall }[] {
  const out: { station: string; role: string; call: ModelCall }[] = []
  const clf = byStation.scope?.evidence?.classifier
  if (clf && Array.isArray(clf.votes)) clf.votes.forEach((v: unknown, i: number) => { if (isCall(v)) out.push({ station: 'scope', role: `classifier · vote ${i + 1}`, call: v }) })
  else if (isCall(clf)) out.push({ station: 'scope', role: 'classifier', call: clf })
  for (const a of byStation.reproduce?.evidence?.attempts ?? []) if (isCall(a.generator)) out.push({ station: 'reproduce', role: `generator · candidate ${a.candidate}`, call: a.generator })
  for (const a of byStation.fix?.evidence?.fixer_meta?.attempts ?? []) if (isCall(a)) out.push({ station: 'fix', role: `fixer · attempt ${a.attempt}`, call: a })
  const rv = byStation.review?.evidence
  if (isCall(rv)) out.push({ station: 'review', role: 'reviewer', call: rv })
  return out
}
