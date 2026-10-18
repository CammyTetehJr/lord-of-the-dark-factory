// Who works at each stage of a run, built from the run's settings and the recorded evidence.
// Model agents propose or veto; deterministic gates decide. The UI shows both, side by side.
import type { Evidence, ModelCall } from '../api/types'
import type { RunState, StationState } from '../state/reducer'

export type AgentKind = 'model' | 'gate' | 'stand-in' | 'rogue' | 'off'
export type AgentStatus = 'waiting' | 'working' | 'done' | 'skipped' | 'off'

export interface Agent {
  id: string
  name: string
  kind: AgentKind
  /** model id: from the recorded calls once they exist, otherwise the role's default */
  model?: string
  /** false while the model is only the role's default, not yet seen in a recorded call */
  modelConfirmed?: boolean
  /** what this agent is allowed to do */
  power: string
  /** one line: how it works */
  role: string
  status: AgentStatus
  /** one line once it has finished */
  result?: string
  resultTone?: 'pass' | 'escalate' | 'closed' | 'neutral'
  calls: { label: string; call: ModelCall }[]
}

// Defaults from the backend (factory/llm.py MODELS); recorded calls take precedence.
export const ROLE_MODEL = {
  classifier: 'nvidia/Nemotron-3_5-Lightning',
  writer: 'nvidia/nemotron-3-super-120b-a12b',
  fixer: 'nvidia/nemotron-3-super-120b-a12b',
  reviewer: 'nvidia/Nemotron-3-Ultra-550b-a55b',
}

const isCall = (x: unknown): x is ModelCall & Evidence => typeof x === 'object' && x !== null && 'model' in x

function statusOf(st: StationState | undefined): AgentStatus {
  switch (st?.status) {
    case 'running': return 'working'
    case 'pass': case 'escalate': case 'closed': return 'done'
    case 'held': case 'skipped': return 'skipped'
    default: return 'waiting'
  }
}

function tone(st: StationState | undefined): Agent['resultTone'] {
  return st?.status === 'pass' ? 'pass' : st?.status === 'escalate' ? 'escalate' : st?.status === 'closed' ? 'closed' : 'neutral'
}

function modelFrom(calls: { call: ModelCall }[], fallback: string): { model: string; modelConfirmed: boolean } {
  return calls.length ? { model: calls[0].call.model, modelConfirmed: true } : { model: fallback, modelConfirmed: false }
}

function scope(run: RunState, st: StationState | undefined): Agent[] {
  const ev = st?.evidence ?? {}
  const matches: Record<string, string[]> = ev.rules?.matches ?? ev.matches ?? {}
  const hits = Object.entries(matches)
  const rules: Agent = {
    id: 'scope-rules', name: 'Scope rules', kind: 'gate', power: 'can only escalate',
    role: 'Keyword rules for areas no autonomous change may touch: auth, schema, security, data loss, non-determinism.',
    status: statusOf(st), calls: [],
    result: st?.evidence ? (hits.length ? `matched ${hits.map(([a, w]) => `${a} (“${w[0]}”)`).join(', ')}` : 'no protected area mentioned') : undefined,
    resultTone: st?.evidence ? (hits.length ? 'escalate' : 'pass') : 'neutral',
  }
  const clf = ev.classifier
  const enabled = run.classifier ? run.classifier === 'nemotron' : isCall(clf) || Array.isArray(clf?.votes)
  if (!enabled || clf === 'disabled') {
    return [rules, { id: 'classifier', name: 'Scope classifier', kind: 'off', power: 'can only escalate', role: 'Nemotron judges whether the bug is trivial.', status: 'off', calls: [], result: 'disabled for this run' }]
  }
  const calls = Array.isArray(clf?.votes)
    ? clf.votes.filter(isCall).map((v: ModelCall, i: number) => ({ label: `vote ${i + 1}`, call: v }))
    : isCall(clf) ? [{ label: 'vote', call: clf }] : []
  let result: string | undefined
  if (st?.evidence && clf === null) result = 'not consulted: a rule already escalated'
  else if (Array.isArray(clf?.votes)) result = `${clf.trivial_votes}/${clf.votes.length} votes say trivial (${clf.needed} needed)`
  else if (isCall(clf) && clf.answer) result = clf.answer.trivial ? `trivial (${clf.answer.category ?? '?'})` : 'not trivial'
  const classifier: Agent = {
    id: 'classifier', name: 'Scope classifier', kind: 'model', ...modelFrom(calls, ROLE_MODEL.classifier),
    power: 'can only escalate', role: 'Three independent votes on whether the bug is trivial; two must say yes.',
    status: clf === null && st?.evidence ? 'skipped' : statusOf(st), calls, result, resultTone: result ? tone(st) : 'neutral',
  }
  return [rules, classifier]
}

function reproduce(run: RunState, st: StationState | undefined): Agent[] {
  const ev = st?.evidence ?? {}
  const attempts: Evidence[] = ev.attempts ?? []
  const calls = attempts.filter((a) => isCall(a.generator)).map((a) => ({ label: `candidate ${a.candidate}`, call: a.generator as ModelCall }))
  const qualified = attempts.find((a) => a.qualified)
  const nemotron = run.reproducer === 'nemotron'
  const writer: Agent = nemotron
    ? { id: 'writer', name: 'Test writer', kind: 'model', ...modelFrom(calls, ROLE_MODEL.writer), power: 'proposes',
        role: 'Writes up to three candidate reproducing tests in parallel. It does not decide whether they count.',
        status: statusOf(st), calls,
        result: st?.evidence ? (qualified ? `${attempts.length} candidate${attempts.length > 1 ? 's' : ''} tried; candidate ${qualified.candidate} qualified` : `${attempts.length} candidates, none qualified`) : undefined,
        resultTone: st?.evidence ? (qualified ? 'pass' : 'escalate') : 'neutral' }
    : { id: 'writer', name: 'Test writer', kind: 'stand-in', power: 'proposes',
        role: 'Dev stand-in: replays a hand-written reproducing test (factory/dev_repro). No model calls.',
        status: statusOf(st), calls: [], result: st?.evidence ? (qualified ? 'stand-in test supplied' : 'no stand-in test for this bug') : undefined }
  const gate: Agent = {
    id: 'repro-gate', name: 'Reproduce gate', kind: 'gate', power: 'decides',
    role: 'Runs each candidate three times on the buggy code. It must fail every time, the same way, for a plausible reason.',
    status: statusOf(st), calls: [],
    result: st?.evidence ? (qualified ? qualified.reason : st.reason) : undefined, resultTone: qualified ? 'pass' : tone(st),
  }
  const out = [writer, gate]
  if (run.deploy === 'canary' || ev.production_check) {
    const pc = ev.production_check
    out.push({
      id: 'prod-check', name: 'Production check', kind: 'gate', power: 'can close the run',
      role: 'Runs the reproducing test against what production runs now. If it already passes, there is nothing to fix.',
      status: pc ? 'done' : statusOf(st) === 'done' ? 'skipped' : statusOf(st), calls: [],
      result: !pc ? undefined : typeof pc === 'string' ? pc : `already fixed by ${String(pc.fixed_by).slice(0, 7)} (${pc.fixed_by_subject})`,
      resultTone: pc && typeof pc === 'object' ? 'closed' : 'neutral',
    })
  }
  return out
}

function fix(run: RunState, st: StationState | undefined): Agent[] {
  const ev = st?.evidence ?? {}
  const attempts: Evidence[] = ev.fixer_meta?.attempts ?? []
  const calls = attempts.filter(isCall).map((a) => ({ label: `attempt ${a.attempt}`, call: a as ModelCall }))
  const last = attempts[attempts.length - 1]
  const secs = ev.seconds != null ? ` in ${ev.seconds}s` : ''
  if (run.fixer === 'nemotron') {
    return [{ id: 'fixer', name: 'Fixer', kind: 'model', ...modelFrom(calls, ROLE_MODEL.fixer), power: 'proposes a diff (untrusted)',
      role: 'Black box. Search/replace edits in its own copy of the repo, with test feedback, up to three attempts.',
      status: statusOf(st), calls,
      result: st?.evidence ? (last ? `attempt ${last.attempt} of ${attempts.length}: ${last.result}${secs}` : st.reason) : undefined, resultTone: tone(st) }]
  }
  if (run.fixer.startsWith('rogue:')) {
    return [{ id: 'fixer', name: 'Fixer', kind: 'rogue', power: 'proposes a diff (untrusted)',
      role: `Adversarial stand-in (${run.fixer.slice(6)}): misbehaves on purpose to prove the gates hold. No model calls.`,
      status: statusOf(st), calls: [], result: st?.evidence ? `returned a diff${secs}` : undefined, resultTone: tone(st) }]
  }
  return [{ id: 'fixer', name: 'Fixer', kind: 'stand-in', power: 'proposes a diff (untrusted)',
    role: 'Dev stand-in: applies the known-good reference patch. No model calls.',
    status: statusOf(st), calls: [], result: st?.evidence ? `returned a diff${secs}` : undefined, resultTone: tone(st) }]
}

function oracle(st: StationState | undefined): Agent[] {
  const ev = st?.evidence ?? {}
  const runs: string[] = ev.repro_test?.runs ?? []
  const passed = ev.suite?.attempts?.[0]?.counts?.passed
  return [{ id: 'oracle', name: 'Oracle', kind: 'gate', power: 'decides',
    role: 'On a clean checkout with the diff applied: the reproducing test must go green on every rerun, and the full suite must stay green.',
    status: statusOf(st), calls: [],
    result: st?.evidence ? (ev.git_apply ? 'diff does not apply' : `repro ${runs.filter((r) => r === 'green').length}/${runs.length} green · suite ${passed ?? '?'} passed${ev.suite?.flaky ? ' (flaky)' : ''}`) : undefined,
    resultTone: tone(st) }]
}

function inspection(st: StationState | undefined): Agent[] {
  const checks: { check: string; ok: boolean }[] = st?.evidence?.checks ?? []
  const failed = checks.filter((c) => !c.ok).map((c) => c.check)
  return [{ id: 'inspector', name: 'Diff inspector', kind: 'gate', power: 'decides',
    role: 'Ten policy checks on the diff itself: size, protected paths, dependencies, secrets, test tampering, risky calls.',
    status: statusOf(st), calls: [],
    result: st?.evidence ? (failed.length ? `failed: ${failed.join(', ')}` : `${checks.length}/${checks.length} checks passed`) : undefined,
    resultTone: tone(st) }]
}

function review(run: RunState, st: StationState | undefined): Agent[] {
  const ev = st?.evidence ?? {}
  if (ev.reviewer === 'disabled' || run.reviewer === 'none') {
    return [{ id: 'reviewer', name: 'Reviewer', kind: 'off', power: 'can only veto', role: 'Nemotron reviews the diff for what tests cannot see.', status: 'off', calls: [], result: 'disabled for this run: nobody reviewed' }]
  }
  const calls = isCall(ev) ? [{ label: 'review', call: ev as ModelCall }] : []
  const a = ev.answer
  return [{ id: 'reviewer', name: 'Reviewer', kind: 'model', ...modelFrom(calls, ROLE_MODEL.reviewer), power: 'can only veto',
    role: 'A larger model than the fixer reviews the accepted diff for what tests cannot see: hardcoded inputs, masked symptoms, unrelated changes.',
    status: statusOf(st), calls,
    result: a && typeof a === 'object' ? `${a.verdict}${a.confidence != null ? ` (confidence ${Number(a.confidence).toFixed(2)})` : ''}${a.concerns?.length ? `: ${a.concerns.join('; ')}` : ''}` : st?.evidence ? st.reason : undefined,
    resultTone: tone(st) }]
}

function deploy(run: RunState, st: StationState | undefined): Agent[] {
  const ev = st?.evidence ?? {}
  const canary = (ev.mode ?? run.deploy) === 'canary'
  const steps: Evidence[] = ev.steps ?? []
  let result: string | undefined
  if (st?.evidence) {
    if (!canary) result = ev.branch ? `committed to ${ev.branch}` : st.reason
    else if (ev.promoted_commit) result = `canary ${steps.map((s) => `${s.canary_pct}%`).join(' → ')}; promoted ${String(ev.promoted_commit).slice(0, 7)}`
    else {
      const bad = steps.find((s) => !s.ok)
      result = bad ? `rolled back at ${bad.canary_pct}%: ${bad.detail}` : st.reason
    }
  } else if (st?.status === 'running' && run.canary?.steps.length) {
    result = `canary at ${run.canary.steps[run.canary.steps.length - 1].pct}%`
  }
  return [{ id: 'release', name: 'Release gate', kind: 'gate', power: 'decides',
    role: canary
      ? 'Starts the fix next to production and shifts traffic 10% → 50% → 100%, comparing errors and p95 against stable. Any breach or the andon cord rolls it back.'
      : 'Commits the verified fix to a release branch. No production deploy for this run.',
    status: statusOf(st), calls: [], result, resultTone: tone(st) }]
}

export function agentsFor(run: RunState, station: string): Agent[] {
  const st = run.byStation[station]
  switch (station) {
    case 'scope': return scope(run, st)
    case 'baseline': {
      const counts = st?.evidence?.tests?.counts ?? {}
      return [{ id: 'runner', name: 'Test runner', kind: 'gate', power: 'decides',
        role: "Runs the target's regression suite on the base commit. A red baseline would make every later check meaningless.",
        status: statusOf(st), calls: [], result: st?.evidence ? Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ') : undefined, resultTone: tone(st) }]
    }
    case 'reproduce': return reproduce(run, st)
    case 'fix': return fix(run, st)
    case 'oracle': return oracle(st)
    case 'diff_inspection': return inspection(st)
    case 'review': return review(run, st)
    case 'deploy': return deploy(run, st)
    default: return []
  }
}

export interface CrewMember extends Agent {
  station: string
  tokens: number
  seconds: number
}

/** Everyone who worked on (or is assigned to) this run, model agents first. */
export function crewOf(run: RunState): { models: CrewMember[]; gates: number; calls: number; tokens: number; seconds: number } {
  const all = run.stations.flatMap((s) => agentsFor(run, s).map((a) => ({
    ...a, station: s,
    tokens: a.calls.reduce((n, c) => n + (c.call.prompt_tokens ?? 0) + (c.call.completion_tokens ?? 0), 0),
    seconds: a.calls.reduce((n, c) => n + (c.call.seconds ?? 0), 0),
  })))
  const models = all.filter((a) => a.kind !== 'gate')
  const gates = new Set(all.filter((a) => a.kind === 'gate').map((a) => a.id)).size
  return {
    models, gates,
    calls: models.reduce((n, a) => n + a.calls.length, 0),
    tokens: models.reduce((n, a) => n + a.tokens, 0),
    seconds: models.reduce((n, a) => n + a.seconds, 0),
  }
}
