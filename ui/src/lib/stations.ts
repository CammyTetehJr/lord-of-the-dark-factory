// What each station is, for the board header and the colour rules:
// violet = a model wrote or judged it; steel = a deterministic gate.

export type StationKind = 'gate' | 'model'

export interface StationInfo {
  label: string
  group: string
  kind: StationKind
  /** one line shown on hover and in the drawer */
  question: string
}

const INFO: Record<string, StationInfo> = {
  scope: { label: 'Scope', group: 'pre-check', kind: 'gate', question: 'Is this bug allowed to be fixed autonomously? Rules first, then a Nemotron classifier that can only escalate.' },
  baseline: { label: 'Baseline', group: 'pre-check', kind: 'gate', question: 'Is the regression suite green before we start?' },
  reproduce: { label: 'Reproduce', group: 'pre-check', kind: 'gate', question: 'Is there a test that fails deterministically, for the right reason? Nemotron proposes, the gate decides.' },
  fix: { label: 'Fix', group: 'black box', kind: 'model', question: 'Black box: bug and failing test in, diff out. Nothing inside is trusted.' },
  oracle: { label: 'Oracle', group: 'post-check', kind: 'gate', question: 'Repro test red to green on every rerun, full suite green.' },
  diff_inspection: { label: 'Diff check', group: 'post-check', kind: 'gate', question: 'Small, no protected paths, no dependencies, no secrets, no test tampering.' },
  review: { label: 'Review', group: 'veto', kind: 'model', question: 'Nemotron Ultra reviews the diff. It can veto, never approve.' },
  deploy: { label: 'Deploy', group: 'release', kind: 'gate', question: 'Gated release.' },
}

export function stationInfo(id: string): StationInfo {
  return INFO[id] ?? { label: id.replace(/_/g, ' '), group: 'other', kind: 'gate', question: '' }
}

/** Consecutive stations sharing a group, for the header row. */
export function groupsOf(stations: string[]): { group: string; span: number; kind: StationKind }[] {
  const out: { group: string; span: number; kind: StationKind }[] = []
  for (const s of stations) {
    const { group, kind } = stationInfo(s)
    const last = out[out.length - 1]
    if (last && last.group === group) last.span++
    else out.push({ group, span: 1, kind })
  }
  return out
}

export const GROUP_NOTE: Record<string, string> = {
  'post-check': 'both always run',
  veto: 'can only veto',
  'black box': 'untrusted',
}

export const shortModel = (m: string) => m.split('/').pop() ?? m
