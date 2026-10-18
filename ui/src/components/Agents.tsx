import { AnimatePresence, motion } from 'motion/react'
import { useState } from 'react'
import { agentsFor, crewOf, type Agent } from '../lib/agents'
import { shortModel, stationInfo } from '../lib/stations'
import type { RunState, StationState } from '../state/reducer'
import { Lamp } from './Board'
import { CanaryPanel, canaryOf } from './CanaryPanel'
import { Call, HideCalls, StationEvidence } from './Evidence'

const KIND_LABEL: Record<Agent['kind'], string> = {
  model: 'model', gate: 'deterministic', 'stand-in': 'dev stand-in', rogue: 'adversarial', off: 'off',
}

/** Compact: who works here, on which model, with what power. Used in step headers and the inspector. */
export function AgentChip({ agent }: { agent: Agent }) {
  return (
    <span className={`agent-chip k-${agent.kind} s-${agent.status}`} title={`${agent.name} · ${KIND_LABEL[agent.kind]}${agent.model ? ` · ${agent.model}` : ''} · ${agent.power}\n${agent.role}`}>
      <i aria-hidden="true" />
      <b>{agent.name}</b>
      {agent.model && <span className="m">{shortModel(agent.model)}</span>}
      {agent.status === 'working' && <span className="w">working</span>}
      {agent.status === 'off' && <span className="w">off</span>}
    </span>
  )
}

export function AgentCard({ agent }: { agent: Agent }) {
  const tokens = agent.calls.reduce((n, c) => n + (c.call.prompt_tokens ?? 0) + (c.call.completion_tokens ?? 0), 0)
  const secs = agent.calls.reduce((n, c) => n + (c.call.seconds ?? 0), 0)
  return (
    <div className={`agent-card k-${agent.kind} s-${agent.status}`}>
      <div className="agent-top">
        <i aria-hidden="true" />
        <b className="agent-name">{agent.name}</b>
        <span className="chip">{KIND_LABEL[agent.kind]}</span>
        <span className="chip power">{agent.power}</span>
        {agent.status === 'working' && <span className="tag running">working</span>}
      </div>
      {agent.model && (
        <div className="agent-model mono">
          {agent.model}
          {!agent.modelConfirmed && <span className="note"> · role default, no call recorded yet</span>}
        </div>
      )}
      <p className="agent-role">{agent.role}</p>
      {agent.result && <p className={`agent-result ${agent.resultTone ?? 'neutral'}`}>{agent.result}</p>}
      {agent.calls.length > 0 && (
        <div className="agent-calls">
          <div className="eyebrow">{agent.calls.length} model call{agent.calls.length > 1 ? 's' : ''} · {tokens.toLocaleString()} tokens · {secs.toFixed(1)}s</div>
          {agent.calls.map((c, i) => <Call key={i} call={c.call} label={c.label} />)}
        </div>
      )}
    </div>
  )
}

/** Everyone on this run: each model agent with its model, calls and tokens; gates counted. */
export function Crew({ run }: { run: RunState }) {
  const crew = crewOf(run)
  return (
    <section>
      <h3>Crew</h3>
      <div className="crew">
        {crew.models.map((a) => (
          <div key={a.id} className={`crew-card k-${a.kind} s-${a.status}`}>
            <div className="agent-top"><i aria-hidden="true" /><b>{a.name}</b></div>
            <div className="crew-stage eyebrow">{stationInfo(a.station).label} · {a.power}</div>
            <div className="crew-model mono">{a.model ? shortModel(a.model) : KIND_LABEL[a.kind]}</div>
            <div className="crew-stats tnum">
              {a.kind === 'model' && a.calls.length > 0 ? `${a.calls.length} call${a.calls.length > 1 ? 's' : ''} · ${a.tokens.toLocaleString()} tok · ${a.seconds.toFixed(1)}s`
                : a.status === 'working' ? 'working…' : a.status === 'off' ? 'disabled' : a.status === 'skipped' ? 'not reached' : a.status === 'waiting' ? 'waiting' : 'no model calls'}
            </div>
          </div>
        ))}
        <div className="crew-card k-gate">
          <div className="agent-top"><i aria-hidden="true" /><b>{crew.gates} deterministic gates</b></div>
          <div className="crew-stage eyebrow">decide every pass</div>
          <div className="crew-model mono">rules, tests, policy, SLO</div>
          <div className="crew-stats tnum">{crew.calls} model calls · {crew.tokens.toLocaleString()} tok in this run</div>
        </div>
      </div>
    </section>
  )
}

function duration(st: StationState | undefined, now: number): string {
  if (!st?.startedAt) return ''
  const end = st.finishedAt ? Date.parse(st.finishedAt) : now
  const s = Math.max(0, (end - Date.parse(st.startedAt)) / 1000)
  return s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`
}

const OUTCOME_LABEL: Partial<Record<StationState['status'], string>> = {
  pass: 'pass', escalate: 'escalate', closed: 'closed', held: 'stopped', running: 'running', skipped: 'not reached', idle: 'waiting',
}

/** Numbered steps; each header names who works there; details below when expanded. */
export function Steps({ run, now }: { run: RunState; now: number }) {
  const notable = (s: string) => ['escalate', 'running', 'held', 'closed'].includes(run.byStation[s]?.status ?? '')
  const [open, setOpen] = useState<Set<string>>(() => new Set(run.stations.filter(notable)))
  const toggle = (s: string) => setOpen((o) => { const n = new Set(o); if (n.has(s)) n.delete(s); else n.add(s); return n })
  const allOpen = open.size === run.stations.length

  return (
    <section>
      <div className="chips" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
        <h3>Steps</h3>
        <button type="button" className="btn small ghost" onClick={() => setOpen(allOpen ? new Set() : new Set(run.stations))}>{allOpen ? 'Collapse all' : 'Expand all'}</button>
      </div>
      <ol className="steps">
        {run.stations.map((s, i) => {
          const st = run.byStation[s] ?? { status: 'idle' }
          const info = stationInfo(s)
          const agents = agentsFor(run, s)
          const isOpen = open.has(s)
          const off = st.status === 'pass' && st.evidence?.reviewer === 'disabled'
          return (
            <li key={s} className={`step st-${st.status}`} data-station={s}>
              <button type="button" className="step-h" aria-expanded={isOpen} onClick={() => toggle(s)}>
                <span className="step-n tnum">{String(i + 1).padStart(2, '0')}</span>
                <span className={`cell ${info.kind === 'model' ? 'model' : ''}`} data-status={off ? 'off' : st.status}><Lamp /></span>
                <span className="step-main">
                  <span className="step-title">{info.label}</span>
                  <span className="step-agents">{agents.map((a) => <AgentChip key={a.id} agent={a} />)}</span>
                </span>
                <span className="step-meta">
                  <span className={`tag ${st.status === 'skipped' || st.status === 'idle' ? '' : st.status}`}>{off ? 'off' : OUTCOME_LABEL[st.status]}</span>
                  <span className="note tnum">{duration(st, now)}</span>
                </span>
                <span className="step-caret" aria-hidden="true">{isOpen ? '−' : '+'}</span>
              </button>
              <AnimatePresence initial={false}>
                {isOpen && (
                  <motion.div className="step-body" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.22, ease: [0.2, 0.8, 0.2, 1] }}>
                    <div className="step-inner">
                      {st.reason && <p className={`reason ${st.status}`}>{st.reason}</p>}
                      <div className="agent-cards">{agents.map((a) => <AgentCard key={a.id} agent={a} />)}</div>
                      <div className="step-evidence">
                        <div className="eyebrow">Evidence</div>
                        <HideCalls.Provider value={true}>
                          {s === 'deploy' && canaryOf(run)
                            ? <CanaryPanel canary={canaryOf(run)!} evidence={st.evidence} reason={st.reason} showTable />
                            : <StationEvidence station={s} st={st} compact />}
                        </HideCalls.Provider>
                      </div>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </li>
          )
        })}
      </ol>
    </section>
  )
}
