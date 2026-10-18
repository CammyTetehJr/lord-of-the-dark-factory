import type { AuditResult } from '../api/types'

// The server's verify messages (factory/events.py) are full sentences. The pill shows a short form that
// always fits; the full sentence stays in the tooltip.
const CAUSE: [RegExp, string][] = [
  [/content was modified/, 'content modified'],
  [/prev_hash does not match/, 'entry removed, inserted or reordered'],
  [/signature invalid/, 'signature invalid'],
  [/not signed/, 'entry not signed'],
]

/** `key` is shown only on wide screens; the pill always fits on one row at 1280 px without it. */
export function auditLabel(audit: AuditResult | null): { text: string; key?: string; title: string } {
  if (!audit) return { text: 'Checking chain…', title: 'Checking the audit chain' }
  const title = audit.message
  if (audit.ok) {
    if (!audit.events) return { text: '✓ No events yet', title }
    const key = /key ([0-9a-f]+)/.exec(audit.message)?.[1]
    return { text: `✓ Chain intact · ${audit.events.toLocaleString('en')} events · signed`, key: key?.slice(0, 8), title }
  }
  const line = /line (\d+)/.exec(audit.message)?.[1]
  const cause = CAUSE.find(([re]) => re.test(audit.message))?.[1]
  return { text: `✗ Broken${line ? ` at line ${line}` : ''}${cause ? `: ${cause}` : ''}`, title }
}
